'use strict';

const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');
const security = require('./security.cjs');

const DAY = 24 * 3600 * 1000;
const CONNECTED_WINDOW_MS = 2 * 60 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000;
const OK_STATES = "('stored','indexed')";
const PENDING_STATES = "('discovered','queued','uploading')";
const FAILED_STATES = "('failed_retryable','failed_permanent')";
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp']);
const DOCUMENT_EXTENSIONS = new Set(['pdf']);

const SESSION_STATUSES = ['queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'];
const DEVICE_STATUSES = ['connected', 'disconnected', 'syncing', 'error', 'revoked'];
const ERROR_CATEGORIES = ['storage', 'size', 'indexing', 'file_type', 'integrity', 'other'];

const text = (value, max = 100) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const oneOf = (value, list) => (list.includes(value) ? value : '');
const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
};
const timestamp = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

function errorCategory(message) {
  const value = String(message || '').toLowerCase();
  if (!value) return '';
  if (/disk space|storage/.test(value)) return 'storage';
  if (/exceeds|limit|size/.test(value)) return 'size';
  if (/index/.test(value)) return 'indexing';
  if (/type|extension/.test(value)) return 'file_type';
  if (/hash|checksum/.test(value)) return 'integrity';
  return 'other';
}

function sessionStatus(row) {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'open') return row.started > 0 ? 'running' : 'queued';
  if (row.failed > 0) return row.ok > 0 ? 'completed_with_errors' : 'failed';
  return 'completed';
}

function page(rows, { page: requested, pageSize: size }) {
  const pageSize = integer(size, 25, 5, 100);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = integer(requested, 1, 1, pages);
  return { rows: rows.slice((current - 1) * pageSize, current * pageSize), total: rows.length, page: current, pages, pageSize };
}

function sorter(key, direction, accessors) {
  const get = accessors[key] || accessors.default;
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const left = get(a);
    const right = get(b);
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return (left > right ? 1 : -1) * sign;
  };
}

const likeEscape = value => value.replace(/[\\%_]/g, match => `\\${match}`);
const csvCell = value => {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

function localDay(stamp) {
  const date = new Date(stamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createAdmin({ service, dataDir, listLibraries, readIndex, getAccount = async () => null, listAccountUsers = null, statfs = fs.statfs, now = Date.now }) {
  const { repo, db } = service;
  const q = sql => db.prepare(sql);

  // Index files can be large, so library statistics are cached briefly.
  let libraryCache = null;
  async function libraryStats() {
    if (libraryCache && now() - libraryCache.at < 30000) return libraryCache.value;
    const libraries = [];
    for (const library of listLibraries()) {
      const entry = { id: library.id, name: library.name, path: library.path || '', photos: 0, videos: 0, documents: 0, bytes: 0, error: '' };
      try {
        const index = await readIndex(library.id);
        for (const item of index.entries) {
          if (item.missing) continue;
          if (VIDEO_EXTENSIONS.has(item.extension)) entry.videos += 1;
          else if (DOCUMENT_EXTENSIONS.has(item.extension)) entry.documents += 1;
          else entry.photos += 1;
          entry.bytes += item.size || 0;
        }
      } catch (error) { entry.error = error.message; }
      libraries.push(entry);
    }
    const value = { libraries, photos: 0, videos: 0, documents: 0, bytes: 0 };
    for (const item of libraries) { value.photos += item.photos; value.videos += item.videos; value.documents += item.documents; value.bytes += item.bytes; }
    libraryCache = { at: now(), value };
    return value;
  }

  async function diskSpace(target) {
    try {
      const stats = await statfs(target);
      return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
    } catch { return null; }
  }

  function connectionStatus(row, running) {
    if (row.revoked_at) return 'revoked';
    const recent = Boolean(row.last_seen_at) && now() - row.last_seen_at < CONNECTED_WINDOW_MS;
    if (running && recent && row.pending > 0) return 'syncing';
    if (row.failed > 0) return 'error';
    return running && recent ? 'connected' : 'disconnected';
  }

  const deviceRows = () => q(`
    SELECT d.id, d.name, d.platform, d.created_at, d.last_seen_at, d.last_sync_at, d.revoked_at,
      COALESCE(SUM(CASE WHEN a.state IN ${OK_STATES} THEN 1 ELSE 0 END), 0) AS synced,
      COALESCE(SUM(CASE WHEN a.state IN ${PENDING_STATES} THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN a.state IN ${FAILED_STATES} THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN a.state IN ${OK_STATES} THEN a.size ELSE 0 END), 0) AS bytes
    FROM devices d LEFT JOIN assets a ON a.device_id = d.id
    WHERE d.removed_at IS NULL GROUP BY d.id ORDER BY d.created_at`).all();

  function serializeDevice(row, running) {
    return {
      id: row.id, name: row.name, platform: row.platform, createdAt: row.created_at, lastSeenAt: row.last_seen_at, lastSyncAt: row.last_sync_at,
      synced: row.synced, pending: row.pending, failed: row.failed, bytes: row.bytes,
      status: connectionStatus(row, running), authorization: row.revoked_at ? 'revoked' : 'authorized', revokedAt: row.revoked_at
    };
  }

  function devices(filters = {}) {
    const running = service.isRunning();
    const search = text(filters.search).toLowerCase();
    const status = oneOf(filters.status, DEVICE_STATUSES);
    let rows = deviceRows().map(row => serializeDevice(row, running));
    if (search) rows = rows.filter(row => `${row.name} ${row.id} ${row.platform}`.toLowerCase().includes(search));
    if (status) rows = rows.filter(row => row.status === status);
    rows.sort(sorter(text(filters.sort, 20), filters.dir === 'asc' ? 'asc' : 'desc', {
      default: row => row.lastSeenAt, name: row => row.name.toLowerCase(), platform: row => row.platform, status: row => row.status,
      lastSync: row => row.lastSyncAt, synced: row => row.synced, pending: row => row.pending
    }));
    return page(rows, filters);
  }

  function sessionRows(filters = {}) {
    const where = [];
    const params = [];
    const from = timestamp(filters.from);
    const to = timestamp(filters.to);
    const deviceId = text(filters.deviceId, 64);
    const sessionId = text(filters.id, 64);
    if (sessionId) { where.push('s.id = ?'); params.push(sessionId); }
    if (from) { where.push('s.created_at >= ?'); params.push(from); }
    if (to) { where.push('s.created_at < ?'); params.push(to); }
    if (deviceId) { where.push('s.device_id = ?'); params.push(deviceId); }
    return q(`
      SELECT s.id, s.device_id, s.status, s.created_at, s.completed_at, d.name AS device_name,
        COUNT(a.id) AS total,
        COALESCE(SUM(CASE WHEN a.state IN ${OK_STATES} THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE WHEN a.state IN ${FAILED_STATES} THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN a.state IN ${PENDING_STATES} THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN a.state = 'uploading' OR a.bytes_received > 0 OR a.state IN ${OK_STATES} THEN 1 ELSE 0 END), 0) AS started,
        COALESCE(SUM(a.bytes_received), 0) AS bytes,
        COALESCE(SUM(a.size), 0) AS size_total,
        COALESCE(SUM(CASE WHEN a.media_kind = 'image' THEN 1 ELSE 0 END), 0) AS images,
        COALESCE(SUM(CASE WHEN a.media_kind = 'video' THEN 1 ELSE 0 END), 0) AS videos
      FROM sync_sessions s JOIN devices d ON d.id = s.device_id LEFT JOIN assets a ON a.session_id = s.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY s.id ORDER BY s.created_at DESC LIMIT 5000`).all(...params);
  }

  function serializeSession(row, categories) {
    const status = sessionStatus(row);
    const active = status === 'running' || status === 'queued';
    return {
      id: row.id, deviceId: row.device_id, deviceName: row.device_name, status, startedAt: row.created_at, endedAt: row.completed_at,
      durationMs: row.completed_at ? row.completed_at - row.created_at : (active ? now() - row.created_at : null),
      total: row.total, succeeded: row.ok, failed: row.failed, pending: row.pending, bytes: row.bytes, totalBytes: row.size_total,
      images: row.images, videos: row.videos, errorCategories: categories || []
    };
  }

  function failedCategories() {
    const map = new Map();
    for (const row of q(`SELECT DISTINCT session_id, last_error FROM assets WHERE state IN ${FAILED_STATES} AND session_id IS NOT NULL`).all()) {
      if (!map.has(row.session_id)) map.set(row.session_id, new Set());
      map.get(row.session_id).add(errorCategory(row.last_error));
    }
    return map;
  }

  function filteredSessions(filters = {}) {
    const search = text(filters.search).toLowerCase();
    const status = oneOf(filters.status, SESSION_STATUSES);
    const media = oneOf(filters.media, ['image', 'video']);
    const category = oneOf(filters.errorCategory, ERROR_CATEGORIES);
    const categories = failedCategories();
    let rows = sessionRows(filters).map(row => serializeSession(row, [...(categories.get(row.id) || [])]));
    if (search) rows = rows.filter(row => `${row.id} ${row.deviceName}`.toLowerCase().includes(search));
    if (status) rows = rows.filter(row => row.status === status);
    if (media) rows = rows.filter(row => (media === 'image' ? row.images : row.videos) > 0);
    if (category) rows = rows.filter(row => row.errorCategories.includes(category));
    rows.sort(sorter(text(filters.sort, 20), filters.dir === 'asc' ? 'asc' : 'desc', {
      default: row => row.startedAt, device: row => row.deviceName.toLowerCase(), duration: row => row.durationMs, files: row => row.total,
      failed: row => row.failed, bytes: row => row.bytes, status: row => row.status
    }));
    return rows;
  }

  const sessions = (filters = {}) => page(filteredSessions(filters), filters);

  function sessionsCsv(filters = {}) {
    const header = ['Session ID', 'Device', 'Started', 'Ended', 'Duration (s)', 'Total files', 'Synchronized', 'Failed', 'Bytes transferred', 'Status'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of filteredSessions(filters)) {
      lines.push([
        row.id, row.deviceName, new Date(row.startedAt).toISOString(), row.endedAt ? new Date(row.endedAt).toISOString() : '',
        row.durationMs === null ? '' : Math.round(row.durationMs / 1000), row.total, row.succeeded, row.failed, row.bytes, row.status
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n');
  }

  // Only file names, sizes and states are returned; library paths and tokens are never part of the history.
  function sessionDetail(id) {
    const key = text(id, 64);
    const row = sessionRows({ id: key })[0];
    if (!row) throw new Error('Session not found.');
    const files = q(`SELECT id, filename, media_kind, size, state, bytes_received, retry_count, last_error, sha256, duplicate_of
                     FROM assets WHERE session_id = ? ORDER BY updated_at DESC LIMIT 500`).all(key).map(file => {
      const failed = file.state === 'failed_retryable' || file.state === 'failed_permanent';
      return {
        id: file.id, name: file.filename, kind: file.media_kind, size: file.size, state: file.state, bytesReceived: file.bytes_received,
        retryCount: file.retry_count, error: failed ? file.last_error : '', errorCategory: failed ? errorCategory(file.last_error) : '',
        duplicate: Boolean(file.duplicate_of), checksum: file.sha256 && ['stored', 'indexed'].includes(file.state) ? 'recorded' : 'unavailable',
        sha256: file.sha256 ? file.sha256.slice(0, 16) : ''
      };
    });
    const summary = serializeSession(row, []);
    return {
      session: summary, files, truncated: summary.total > files.length,
      activity: q('SELECT ts, severity, message FROM activity_log WHERE session_id = ? ORDER BY ts DESC LIMIT 20').all(key)
    };
  }

  // Retrying reuses the importer queue; requeue only applies to failed assets, so repeating the call is harmless.
  async function retrySession(id) {
    const failed = q(`SELECT id FROM assets WHERE session_id = ? AND state IN ${FAILED_STATES}`).all(text(id, 64));
    let retried = 0;
    for (const { id: assetId } of failed) {
      try { await service.retryAsset(assetId); retried += 1; } catch { /* the asset keeps its failed state and error */ }
    }
    repo.logEvent({ kind: 'retry_requested', message: `Retry requested for ${retried} failed file(s).`, sessionId: text(id, 64), result: retried ? 'success' : 'nothing_to_retry' });
    return { retried, requested: failed.length };
  }

  function deviceDetail(id) {
    const key = text(id, 64);
    const row = deviceRows().find(item => item.id === key);
    if (!row) throw new Error('Device not found.');
    const running = service.isRunning();
    const categories = failedCategories();
    const uploads = Object.fromEntries(q('SELECT state, COUNT(*) AS n FROM assets WHERE device_id = ? GROUP BY state').all(key).map(item => [item.state, item.n]));
    const totals = q(`SELECT COALESCE(SUM(bytes_received), 0) AS bytes, COUNT(CASE WHEN media_kind = 'image' THEN 1 END) AS images, COUNT(CASE WHEN media_kind = 'video' THEN 1 END) AS videos,
                      COUNT(CASE WHEN duplicate_of IS NOT NULL THEN 1 END) AS duplicates FROM assets WHERE device_id = ?`).get(key);
    return {
      device: serializeDevice(row, running),
      uploads, totals,
      sessions: sessionRows({ deviceId: key }).slice(0, 10).map(item => serializeSession(item, [...(categories.get(item.id) || [])])),
      errors: q(`SELECT filename, last_error, retry_count, updated_at, state FROM assets WHERE device_id = ? AND state IN ${FAILED_STATES} ORDER BY updated_at DESC LIMIT 10`).all(key)
        .map(item => ({ name: item.filename, message: item.last_error, retryCount: item.retry_count, at: item.updated_at, state: item.state })),
      activity: q('SELECT ts, severity, message FROM activity_log WHERE device_id = ? ORDER BY ts DESC LIMIT 10').all(key)
    };
  }

  function activity(filters = {}) {
    const where = [];
    const params = [];
    const category = oneOf(filters.category, ['operational', 'security']);
    const severity = oneOf(filters.severity, ['info', 'warning', 'error']);
    const search = text(filters.search);
    const deviceId = text(filters.deviceId, 64);
    if (category) { where.push('l.category = ?'); params.push(category); }
    if (severity) { where.push('l.severity = ?'); params.push(severity); }
    if (deviceId) { where.push('l.device_id = ?'); params.push(deviceId); }
    if (search) { where.push("(l.message LIKE ? ESCAPE '\\' OR l.kind LIKE ? ESCAPE '\\')"); params.push(`%${likeEscape(search)}%`, `%${likeEscape(search)}%`); }
    if (timestamp(filters.from)) { where.push('l.ts >= ?'); params.push(timestamp(filters.from)); }
    if (timestamp(filters.to)) { where.push('l.ts < ?'); params.push(timestamp(filters.to)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = { time: 'l.ts', severity: 'l.severity', category: 'l.category', kind: 'l.kind' }[filters.sort] || 'l.ts';
    const direction = filters.dir === 'asc' ? 'ASC' : 'DESC';
    const pageSize = integer(filters.pageSize, 25, 5, 100);
    const total = q(`SELECT COUNT(*) AS n FROM activity_log l ${clause}`).get(...params).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = integer(filters.page, 1, 1, pages);
    const rows = q(`SELECT l.id, l.ts, l.category, l.severity, l.kind, l.message, l.device_id, l.session_id, l.result, d.name AS device_name
                    FROM activity_log l LEFT JOIN devices d ON d.id = l.device_id ${clause}
                    ORDER BY ${order} ${direction}, l.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (current - 1) * pageSize)
      .map(row => ({ id: row.id, at: row.ts, category: row.category, severity: row.severity, kind: row.kind, message: row.message, deviceId: row.device_id, deviceName: row.device_name, sessionId: row.session_id, result: row.result }));
    return { rows, total, page: current, pages, pageSize };
  }

  function probe(status) {
    if (!status.running) return Promise.resolve({ reachable: false, error: 'The sync server is stopped.' });
    return new Promise(resolve => {
      const started = now();
      const client = status.url.startsWith('https') ? https : http;
      const request = client.get(`${status.url}/api/v1/ping`, { rejectUnauthorized: false, timeout: 2500 }, response => {
        response.resume();
        resolve({ reachable: response.statusCode === 200, latencyMs: now() - started, error: response.statusCode === 200 ? '' : `Unexpected response ${response.statusCode}.` });
      });
      request.on('timeout', () => { request.destroy(); resolve({ reachable: false, error: 'The server did not answer in time.' }); });
      request.on('error', error => resolve({ reachable: false, error: error.message }));
    });
  }

  async function wifi() {
    const status = service.status();
    const running = status.running;
    const host = running ? new URL(status.url).hostname : '';
    const port = running ? Number(new URL(status.url).port) : status.settings.port;
    const interfaces = security.lanAddresses();
    const rows = deviceRows().map(row => serializeDevice(row, running));
    const lastError = q("SELECT ts, message FROM activity_log WHERE kind = 'server_error' ORDER BY ts DESC LIMIT 1").get();
    const uploading = q("SELECT COUNT(*) AS n FROM assets WHERE state = 'uploading'").get().n;
    const warnings = [];
    if (running && !interfaces.some(item => item.address === host)) warnings.push(`The network interface ${host} is no longer available. Restart the server after reconnecting to Wi-Fi.`);
    if (!running && !interfaces.length) warnings.push('No private Wi-Fi/LAN address is available. Connect this PC to a local network before starting the server.');
    if (!status.libraries.length) warnings.push('No photo folder is connected, so uploads have no destination.');
    const reachability = await probe(status);
    if (running && !reachability.reachable) warnings.push(`The server is marked running but did not answer: ${reachability.error}`);
    return {
      running, url: status.url, host, port, startedAt: running ? service.startedAt() : null, interface: host,
      interfaces: interfaces.map(item => ({ name: item.name, address: item.address })),
      pairedDevices: rows.filter(row => row.authorization === 'authorized').length,
      connectedClients: rows.filter(row => ['connected', 'syncing'].includes(row.status)).length,
      activeUploads: uploading, speedBytesPerSecond: status.speedBytesPerSecond,
      lastError: lastError ? { at: lastError.ts, message: lastError.message } : null,
      security: { tls: Boolean(status.fingerprint), fingerprint: status.fingerprint, privateOnly: running ? security.isPrivateAddress(host) : true, pairingTtlSeconds: status.settings.pairingTtlSeconds },
      reachability, warnings, settings: status.settings, libraries: status.libraries, pairing: status.pairing
    };
  }

  async function overview() {
    const status = service.status();
    const running = status.running;
    const rows = deviceRows().map(row => serializeDevice(row, running));
    const library = await libraryStats();
    const counts = status.stats.counts;
    const synced = q(`SELECT media_kind, COUNT(*) AS n FROM assets WHERE state IN ${OK_STATES} GROUP BY media_kind`).all();
    const syncedBy = kind => (synced.find(item => item.media_kind === kind) || { n: 0 }).n;
    const sessionList = filteredSessions({});
    const space = await diskSpace(library.libraries[0]?.path || dataDir);

    const days = [];
    for (let i = 13; i >= 0; i -= 1) days.push(localDay(now() - i * DAY));
    const perDay = new Map(q(`SELECT strftime('%Y-%m-%d', COALESCE(stored_at, updated_at) / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n, SUM(size) AS bytes
                              FROM assets WHERE state IN ${OK_STATES} GROUP BY day`).all().map(item => [item.day, item]));
    const first30 = localDay(now() - 29 * DAY);
    let running_total = 0;
    for (const [day, item] of perDay) if (day < first30) running_total += item.bytes || 0;
    const cumulative = [];
    for (let i = 29; i >= 0; i -= 1) {
      const day = localDay(now() - i * DAY);
      running_total += (perDay.get(day) || {}).bytes || 0;
      cumulative.push({ day, bytes: running_total });
    }

    const accounts = await users();
    return {
      cards: {
        users: accounts.directory.available ? accounts.directory.users.length : null,
        pairedDevices: rows.filter(row => row.authorization === 'authorized').length,
        connectedDevices: rows.filter(row => ['connected', 'syncing'].includes(row.status)).length,
        activeSessions: sessionList.filter(row => ['running', 'queued'].includes(row.status)).length,
        syncedPhotos: syncedBy('image'), syncedVideos: syncedBy('video'),
        failedJobs: (counts.failed_retryable || 0) + (counts.failed_permanent || 0),
        pendingJobs: (counts.discovered || 0) + (counts.queued || 0) + (counts.uploading || 0),
        libraryBytes: library.bytes
      },
      recentSessions: sessionList.slice(0, 6),
      recentDevices: rows.filter(row => row.lastSeenAt).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 5),
      failedJobs: status.stats.failed.slice(0, 6).map(item => ({ id: item.id, name: item.filename, device: item.device, state: item.state, error: item.last_error, retryCount: item.retry_count })),
      server: { running, url: status.url, port: running ? Number(new URL(status.url).port) : status.settings.port, host: running ? new URL(status.url).hostname : '', speedBytesPerSecond: status.speedBytesPerSecond },
      disk: space,
      events: q("SELECT ts, severity, kind, message FROM activity_log WHERE category = 'security' ORDER BY ts DESC LIMIT 6").all().map(item => ({ at: item.ts, severity: item.severity, kind: item.kind, message: item.message })),
      charts: {
        syncedPerDay: days.map(day => ({ day, count: (perDay.get(day) || {}).n || 0 })),
        results: { succeeded: (counts.stored || 0) + (counts.indexed || 0), failed: (counts.failed_retryable || 0) + (counts.failed_permanent || 0), cancelled: counts.cancelled || 0 },
        cumulativeBytes: cumulative,
        byDevice: q(`SELECT d.name, COUNT(a.id) AS files, COALESCE(SUM(a.size), 0) AS bytes FROM devices d JOIN assets a ON a.device_id = d.id
                     WHERE d.removed_at IS NULL AND a.state IN ${OK_STATES} GROUP BY d.id ORDER BY files DESC LIMIT 8`).all()
      }
    };
  }

  async function folderStats(directory) {
    try {
      let files = 0;
      let bytes = 0;
      for (const name of await fs.readdir(directory)) {
        const stat = await fs.stat(path.join(directory, name)).catch(() => null);
        if (stat && stat.isFile()) { files += 1; bytes += stat.size; }
      }
      return { files, bytes };
    } catch { return { files: 0, bytes: 0 }; }
  }

  async function system() {
    const status = service.status();
    const library = await libraryStats();
    const settings = status.settings;
    const stat = state => q('SELECT COUNT(*) AS n FROM assets WHERE state = ?').get(state).n;
    const pendingIndexing = stat('stored');
    const pendingSync = q(`SELECT COUNT(*) AS n FROM assets WHERE state IN ${PENDING_STATES} OR state = 'failed_retryable'`).get().n;
    const stuck = q("SELECT COUNT(*) AS n FROM assets WHERE state IN ('queued','uploading','stored') AND updated_at < ?").get(now() - STUCK_AFTER_MS).n;
    const space = await diskSpace(library.libraries[0]?.path || dataDir);
    const check = (() => { try { return q('PRAGMA quick_check').get().quick_check; } catch (error) { return error.message; } })();
    const dbFile = await fs.stat(path.join(dataDir, 'wifi-sync.db')).catch(() => null);
    const thumbs = await folderStats(path.join(dataDir, 'thumbs'));
    const warnings = [];
    if (space && (space.freeBytes < settings.minFreeSpaceMB * 1024 * 1024 * 2 || space.freeBytes < space.totalBytes * 0.05)) warnings.push('Free disk space is running low.');
    if (stuck) warnings.push(`${stuck} sync job(s) have not changed for over 30 minutes and may be stuck.`);
    if (check !== 'ok') warnings.push(`Database check reported: ${check}`);
    for (const item of library.libraries) if (item.error) warnings.push(`Library "${item.name}" could not be read: ${item.error}`);
    return {
      libraries: library.libraries, totals: { photos: library.photos, videos: library.videos, documents: library.documents, bytes: library.bytes },
      disk: space, pendingIndexing, pendingSync, stuck,
      indexing: pendingIndexing ? 'working' : 'idle',
      thumbnails: { ...thumbs, mode: 'On demand, cached' },
      database: { status: check === 'ok' ? 'ok' : 'error', detail: check, bytes: dbFile ? dbFile.size : 0, schemaVersion: q('PRAGMA user_version').get().user_version },
      server: { running: status.running, reachable: status.running ? (await probe(status)).reachable : null },
      dataDirectory: dataDir, warnings
    };
  }

  async function users() {
    const profile = await getAccount().catch(() => null);
    let directory = { available: false, reason: 'The account directory is only readable when this app runs the account server itself.', users: [] };
    if (listAccountUsers) {
      try {
        const list = listAccountUsers();
        if (list) directory = { available: true, reason: '', users: list.map(item => ({ id: item.id, email: item.email, displayName: item.display_name, role: item.role || 'user', createdAt: item.created_at, lastLoginAt: item.last_login_at, disabledAt: item.disabled_at || null })) };
      } catch (error) { directory.reason = `The account directory could not be read: ${error.message}`; }
    }
    return { profile: profile ? { email: profile.email, displayName: profile.displayName } : null, directory, deviceCount: deviceRows().filter(row => !row.revoked_at).length };
  }

  return { overview, wifi, devices, deviceDetail, sessions, sessionDetail, sessionsCsv, retrySession, activity, system, users, errorCategory };
}

module.exports = { createAdmin, errorCategory, sessionStatus, SESSION_STATUSES, DEVICE_STATUSES, ERROR_CATEGORIES };
