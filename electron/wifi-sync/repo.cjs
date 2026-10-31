'use strict';

const crypto = require('node:crypto');
const { transaction } = require('./db.cjs');
const security = require('./security.cjs');

const MAX_RETRIES = 6;
const FINAL_STATES = new Set(['indexed', 'failed_permanent', 'cancelled']);

const DEFAULT_SETTINGS = {
  enabled: false,
  familyEnabled: false,
  port: 8443,
  destinationLibraryId: '',
  destinationFolder: 'Wi-Fi Sync',
  bandwidthLimitKBps: 0,
  maxFileSizeMB: 4096,
  minFreeSpaceMB: 500,
  pairingTtlSeconds: 120,
  wifiOnly: true
};

function createRepo(db, { now = Date.now, listAccounts = null } = {}) {
  const q = sql => db.prepare(sql);

  function getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of q('SELECT key, value FROM settings').all()) {
      if (row.key in settings) { try { settings[row.key] = JSON.parse(row.value); } catch { /* keep default */ } }
    }
    return settings;
  }
  function setSettings(patch) {
    const run = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && typeof value === typeof DEFAULT_SETTINGS[key]) run.run(key, JSON.stringify(value));
    }
    return getSettings();
  }

  const MAX_LOG_ROWS = 5000;
  let logWrites = 0;
  // Entries must never contain tokens, pairing codes or passwords; callers pass short human-readable text only.
  function logEvent({ category = 'operational', severity = 'info', kind, message, deviceId = null, sessionId = null, result = 'success' }) {
    q('INSERT INTO activity_log (ts, category, severity, kind, message, device_id, session_id, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), category, severity, kind, String(message).slice(0, 300), deviceId, sessionId, result);
    logWrites += 1;
    if (logWrites % 200 === 0) q('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?').run(MAX_LOG_ROWS);
  }

  function createPairingCode(ttlSeconds) {
    return transaction(db, () => {
      q('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(now());
      const code = security.newPairingCode();
      const expiresAt = now() + ttlSeconds * 1000;
      q('INSERT INTO pairing_codes (code_hash, expires_at, created_at) VALUES (?, ?, ?)').run(security.hashCode(code), expiresAt, now());
      return { code, expiresAt };
    });
  }

  // The single UPDATE makes claiming atomic: a code can only be redeemed once, and only before it expires.
  function claimPairingCode(code, name, platform) {
    return transaction(db, () => {
      const claimed = q('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
        .run(now(), security.hashCode(code), now());
      if (claimed.changes !== 1) return null;
      const token = security.newToken();
      const id = crypto.randomUUID();
      q('INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, platform, security.hashToken(token), now(), now());
      logEvent({ category: 'security', kind: 'device_paired', message: `Device "${name}" (${platform}) paired.`, deviceId: id });
      return { id, token };
    });
  }

  function authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const device = q('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(security.hashToken(token));
    if (device) q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), device.id);
    return device || null;
  }

  const listDevices = () => q('SELECT id, name, platform, created_at, last_seen_at, last_sync_at, revoked_at FROM devices WHERE removed_at IS NULL ORDER BY created_at').all();

  function renameDevice(id, name) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('A device name is required.');
    const result = q('UPDATE devices SET name = ? WHERE id = ? AND removed_at IS NULL').run(clean, id);
    if (result.changes !== 1) throw new Error('Device not found.');
    logEvent({ category: 'security', kind: 'device_renamed', message: `Device renamed to "${clean}".`, deviceId: id });
    return clean;
  }

  // Removing a registration hides the device and revokes its token; imported assets and their files stay untouched.
  function removeDevice(id) {
    const device = q('SELECT id, name FROM devices WHERE id = ? AND removed_at IS NULL').get(id);
    if (!device) throw new Error('Device not found.');
    const revoked = revokeDevice(id);
    q('UPDATE devices SET removed_at = ? WHERE id = ?').run(now(), id);
    logEvent({ category: 'security', kind: 'device_removed', message: `Device "${device.name}" removed from the registered list. Imported photos were kept.`, deviceId: id });
    return revoked;
  }

  function revokeDevice(id) {
    return transaction(db, () => {
      const result = q('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
      if (result.changes !== 1) return { revoked: false, cancelled: [] };
      const device = q('SELECT name FROM devices WHERE id = ?').get(id);
      logEvent({ category: 'security', severity: 'warning', kind: 'device_revoked', message: `Authorization revoked for "${device.name}". Imported photos were kept.`, deviceId: id });
      const cancelled = q("SELECT id FROM assets WHERE device_id = ? AND state IN ('discovered','queued','uploading','failed_retryable')").all(id).map(row => row.id);
      q("UPDATE assets SET state = 'cancelled', updated_at = ? WHERE device_id = ? AND state IN ('discovered','queued','uploading','failed_retryable')").run(now(), id);
      q("UPDATE sync_sessions SET status = 'cancelled' WHERE device_id = ? AND status = 'open'").run(id);
      return { revoked: true, cancelled };
    });
  }

  function createSession(deviceId, key) {
    const existing = q('SELECT * FROM sync_sessions WHERE device_id = ? AND idempotency_key = ?').get(deviceId, key);
    if (existing) return { session: existing, created: false };
    const id = crypto.randomUUID();
    q('INSERT INTO sync_sessions (id, device_id, idempotency_key, created_at) VALUES (?, ?, ?, ?)').run(id, deviceId, key, now());
    logEvent({ kind: 'sync_started', message: 'Synchronization session started.', deviceId, sessionId: id });
    return { session: q('SELECT * FROM sync_sessions WHERE id = ?').get(id), created: true };
  }
  const getSession = (id, deviceId) => q('SELECT * FROM sync_sessions WHERE id = ? AND device_id = ?').get(id, deviceId);

  function completeSession(id) {
    const done = q("UPDATE sync_sessions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'open'").run(now(), id);
    const session = q('SELECT * FROM sync_sessions WHERE id = ?').get(id);
    if (done.changes === 1) {
      const failed = q("SELECT COUNT(*) AS n FROM assets WHERE session_id = ? AND state IN ('failed_retryable','failed_permanent')").get(id).n;
      logEvent({ severity: failed ? 'warning' : 'info', kind: 'sync_completed', message: failed ? `Synchronization completed with ${failed} failed file(s).` : 'Synchronization completed.', deviceId: session.device_id, sessionId: id, result: failed ? 'partial' : 'success' });
    }
    return session;
  }

  // Registering the same source asset again returns the existing row, which makes retries idempotent.
  function registerAsset(deviceId, sessionId, meta) {
    const existing = q('SELECT * FROM assets WHERE device_id = ? AND source_asset_id = ?').get(deviceId, meta.sourceAssetId);
    if (existing) {
      if (!FINAL_STATES.has(existing.state) && existing.session_id !== sessionId) q('UPDATE assets SET session_id = ? WHERE id = ?').run(sessionId, existing.id);
      return { asset: q('SELECT * FROM assets WHERE id = ?').get(existing.id), created: false };
    }
    const id = crypto.randomUUID();
    const stamp = now();
    q(`INSERT INTO assets (id, device_id, session_id, source_asset_id, filename, media_type, media_kind, size, captured_at, state, created_at, updated_at, folder_path, expected_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)`)
      .run(id, deviceId, sessionId, meta.sourceAssetId, meta.filename, meta.mediaType, meta.kind, meta.size, meta.capturedAt, stamp, stamp, meta.folderPath || null, meta.expectedSha256 || null);
    return { asset: q('SELECT * FROM assets WHERE id = ?').get(id), created: true };
  }

  const getAsset = id => q('SELECT * FROM assets WHERE id = ?').get(id);
  const getDeviceAsset = (id, deviceId) => q('SELECT * FROM assets WHERE id = ? AND device_id = ?').get(id, deviceId);

  function update(id, fields) {
    const keys = Object.keys(fields);
    q(`UPDATE assets SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(key => fields[key]), now(), id);
    return getAsset(id);
  }

  // Retryable failures back off exponentially and become permanent after MAX_RETRIES.
  function failRetryable(id, message) {
    const asset = getAsset(id);
    const retries = asset.retry_count + 1;
    logEvent({ severity: 'warning', kind: 'upload_failed', message: `Upload failed for ${asset.filename}: ${message}`, deviceId: asset.device_id, sessionId: asset.session_id, result: retries >= MAX_RETRIES ? 'failed' : 'will_retry' });
    if (retries >= MAX_RETRIES) return update(id, { state: 'failed_permanent', retry_count: retries, last_error: message, next_retry_at: null });
    return update(id, { state: 'failed_retryable', retry_count: retries, last_error: message, next_retry_at: now() + Math.min(30000 * 2 ** retries, 3600000) });
  }
  function failPermanent(id, message) {
    const asset = getAsset(id);
    logEvent({ severity: 'error', kind: 'upload_failed', message: `Upload failed for ${asset.filename}: ${message}`, deviceId: asset.device_id, sessionId: asset.session_id, result: 'failed' });
    return update(id, { state: 'failed_permanent', last_error: message, next_retry_at: null });
  }

  function progress(sessionId) {
    const counts = Object.fromEntries(q('SELECT state, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM assets WHERE session_id = ? GROUP BY state').all(sessionId).map(row => [row.state, { count: row.n, bytes: row.bytes }]));
    const total = q('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes, COALESCE(SUM(bytes_received),0) AS received FROM assets WHERE session_id = ?').get(sessionId);
    return { counts, totalAssets: total.n, totalBytes: total.bytes, receivedBytes: total.received };
  }

  function stats() {
    const counts = Object.fromEntries(q('SELECT state, COUNT(*) AS n FROM assets GROUP BY state').all().map(row => [row.state, row.n]));
    const last = q('SELECT MAX(last_sync_at) AS at FROM devices').get().at;
    const failed = q(`SELECT a.id, a.filename, a.state, a.last_error, a.retry_count, a.next_retry_at, d.name AS device
                      FROM assets a JOIN devices d ON d.id = a.device_id
                      WHERE a.state IN ('failed_retryable','failed_permanent') ORDER BY a.updated_at DESC LIMIT 100`).all();
    return { counts, lastSyncAt: last, failed };
  }

  // Manual retry from the desktop UI.
  function requeue(id) {
    const asset = getAsset(id);
    if (!asset || !['failed_retryable', 'failed_permanent'].includes(asset.state)) return null;
    return update(id, { state: asset.bytes_received >= asset.size ? 'uploading' : 'queued', retry_count: 0, next_retry_at: null, last_error: null });
  }

  const CANCELLABLE = ['discovered', 'queued', 'uploading', 'failed_retryable'];
  // Cancelling only closes the desktop job; files already placed in the library are never touched.
  function cancelAsset(id) {
    return transaction(db, () => {
      const asset = getAsset(id);
      if (!asset) throw new Error('Upload job not found.');
      if (!CANCELLABLE.includes(asset.state)) throw new Error('Only pending, uploading or retrying jobs can be cancelled.');
      if (asset.library_path && asset.stored_at) throw new Error('This file is already in the library; retry indexing instead of cancelling.');
      const result = q(`UPDATE assets SET state = 'cancelled', next_retry_at = NULL, last_error = 'Cancelled by administrator.', updated_at = ? WHERE id = ? AND state IN (${CANCELLABLE.map(() => '?').join(',')})`)
        .run(now(), id, ...CANCELLABLE);
      if (result.changes !== 1) throw new Error('The job changed state; refresh and try again.');
      logEvent({ severity: 'warning', kind: 'asset_cancelled', message: `Upload job for ${asset.filename} was cancelled by an administrator.`, deviceId: asset.device_id, sessionId: asset.session_id, result: 'cancelled' });
      return getAsset(id);
    });
  }

  const touchDeviceSync = deviceId => q('UPDATE devices SET last_sync_at = ? WHERE id = ?').run(now(), deviceId);

  function relocate(libraryId, from, to) {
    q(`UPDATE assets SET library_path = ? || substr(library_path, ?) WHERE library_id = ? AND library_path IS NOT NULL
       AND (library_path = ? OR substr(library_path, 1, ?) = ?)`)
      .run(to, from.length + 1, libraryId, from, from.length + 1, `${from}/`);
  }

  function getIdempotent(deviceId, key, endpoint) {
    const row = q('SELECT status, body FROM idempotent_responses WHERE device_id = ? AND key = ? AND endpoint = ?').get(deviceId, key, endpoint);
    return row ? { status: row.status, body: JSON.parse(row.body) } : null;
  }
  function putIdempotent(deviceId, key, endpoint, status, body) {
    q('INSERT OR IGNORE INTO idempotent_responses (device_id, key, endpoint, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, key, endpoint, status, JSON.stringify(body), now());
  }

  const repo = {
    db, now, getSettings, setSettings, createPairingCode, claimPairingCode, authenticate, listDevices, revokeDevice, renameDevice, removeDevice, logEvent,
    createSession, getSession, completeSession, registerAsset, getAsset, getDeviceAsset, update, failRetryable, failPermanent,
    progress, stats, requeue, cancelAsset, touchDeviceSync, relocate, getIdempotent, putIdempotent
  };
  repo.family = require('./family.cjs').createFamily(repo, listAccounts);
  return repo;
}

module.exports = { createRepo, DEFAULT_SETTINGS, MAX_RETRIES, FINAL_STATES };
