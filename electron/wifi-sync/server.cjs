'use strict';

const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const security = require('./security.cjs');
const { ImportError } = require('./importer.cjs');

const WEB_FILES = {
  '/': ['app.html', 'text/html; charset=utf-8'],
  '/pair': ['index.html', 'text/html; charset=utf-8'],
  '/device': ['device.html', 'text/html; charset=utf-8'],
  '/device.js': ['device.js', 'text/javascript; charset=utf-8'],
  '/device.css': ['device.css', 'text/css; charset=utf-8'],
  '/uploader.js': ['uploader.js', 'text/javascript; charset=utf-8'],
  '/uploader.css': ['uploader.css', 'text/css; charset=utf-8'],
  '/app': ['app.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
  '/chat.css': ['chat.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json']
};
const COOKIE = 'still_device';
const API = '/api/v1';
const JSON_LIMIT = 1024 * 1024;
const MAX_BATCH = 500;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createSyncServer({ repo, importer, tls, libraryApi = null, webDir = path.join(__dirname, 'web'), appVersion = '1.0.0', onChange = () => {}, onBytes = () => {}, now = Date.now, rateLimits = {} }) {
  const pairLimiter = createLimiter(rateLimits.pair || 10, 60000, now);
  const apiLimiter = createLimiter(rateLimits.api || 600, 60000, now);
  const browseLimiter = createLimiter(rateLimits.browse || 6000, 60000, now);
  const authFailLimiter = createLimiter(rateLimits.authFail || 30, 60000, now);
  const auditLimiter = createLimiter(1, 60000, now);

  function createLimiter(limit, windowMs, clock) { return security.createRateLimiter({ limit, windowMs, now: clock }); }

  function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    });
    res.end(payload);
  }

  function fail(res, error) {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError || error instanceof ImportError) {
      const extra = error.code === 'offset_mismatch' ? { 'Upload-Offset': String(error.offset ?? '') } : {};
      send(res, error.status, { error: { code: error.code, message: error.message } }, extra);
      return;
    }
    if (process.env.WIFI_SYNC_DEBUG) console.error(error);
    send(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
  }

  async function readJson(req, limit = JSON_LIMIT) {
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) throw new HttpError(413, 'too_large', 'Request body too large.');
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new HttpError(413, 'too_large', 'Request body too large.');
      chunks.push(chunk);
    }
    if (!total) return {};
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
      return value;
    } catch { throw new HttpError(400, 'invalid_json', 'Body must be a JSON object.'); }
  }

  function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return rest.join('=');
    }
    return '';
  }

  // Browsers cannot attach an Authorization header to <img>/<video> requests, so the paired web app also stores the token in an HttpOnly cookie.
  function authenticate(req, ip) {
    const header = String(req.headers.authorization || '');
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let viaCookie = false;
    if (!token) { token = readCookie(req, COOKIE); viaCookie = Boolean(token); }
    const device = repo.authenticate(token);
    if (!device) {
      authFailLimiter.take(ip);
      // At most one audit row per client per minute so a scan cannot flood the log.
      if (auditLimiter.take(ip)) repo.logEvent({ category: 'security', severity: 'warning', kind: 'auth_failed', message: `Rejected request with a missing, invalid or revoked device token from ${ip}.`, result: 'denied' });
      throw new HttpError(401, 'unauthorized', 'Missing, invalid or revoked device token.');
    }
    // Cookie-authenticated writes must come from our own page (custom header cannot be sent cross-site without CORS).
    if (viaCookie && !['GET', 'HEAD'].includes(req.method) && !req.headers['x-still-app']) throw new HttpError(403, 'forbidden', 'Missing app header.');
    return { ...device, token };
  }

  const serializeAsset = asset => ({
    id: asset.id,
    sourceAssetId: asset.source_asset_id,
    filename: asset.filename,
    state: asset.state,
    size: asset.size,
    bytesReceived: asset.bytes_received,
    sha256: asset.sha256,
    duplicateOf: asset.duplicate_of,
    retryCount: asset.retry_count,
    folderPath: asset.folder_path,
    libraryPath: asset.library_path,
    deviceDeletedAt: asset.device_deleted_at,
    error: asset.last_error
  });
  const serializeSession = session => ({ id: session.id, status: session.status, createdAt: session.created_at, completedAt: session.completed_at, progress: repo.progress(session.id) });

  // A file is safe to delete on the phone only when the PC copy exists on disk and its hash matches the phone's.
  async function verifyForDelete(deviceId, item) {
    const asset = repo.getDeviceAsset(String(item?.assetId || ''), deviceId);
    if (!asset) return { assetId: String(item?.assetId || ''), safeToDelete: false, reason: 'not_found' };
    const original = asset.duplicate_of ? repo.getAsset(asset.duplicate_of) : asset;
    const hash = asset.sha256;
    const clientHash = String(item?.sha256 || '').toLowerCase();
    let reason = null;
    if (!['stored', 'indexed'].includes(asset.state) || !hash || !original) reason = 'not_stored';
    else if (clientHash !== hash) reason = 'hash_mismatch';
    else if (!(await importer.existsOnDisk(original))) reason = 'missing_on_pc';
    return { assetId: asset.id, safeToDelete: !reason, reason, sha256: hash };
  }

  async function handleApi(req, res, url, ip) {
    const route = url.pathname.slice(API.length) || '/';
    const method = req.method;

    if (route === '/ping' && method === 'GET') {
      send(res, 200, { service: 'still-wifi-sync', apiVersion: 1, appVersion, tls: Boolean(tls), time: now() });
      return;
    }
    if (route === '/pairing/claim' && method === 'POST') {
      if (!pairLimiter.take(ip)) {
        repo.logEvent({ category: 'security', severity: 'warning', kind: 'pairing_rejected', message: `Pairing attempts from ${ip} were rate limited.`, result: 'denied' });
        throw new HttpError(429, 'rate_limited', 'Too many pairing attempts. Wait a minute.');
      }
      const body = await readJson(req);
      const name = String(body.deviceName || '').trim().slice(0, 60);
      const platform = String(body.platform || 'unknown').trim().slice(0, 30);
      if (!body.code || !name) throw new HttpError(400, 'invalid_request', 'code and deviceName are required.');
      const device = repo.claimPairingCode(body.code, name, platform);
      if (!device) {
        repo.logEvent({ category: 'security', severity: 'warning', kind: 'pairing_rejected', message: `Pairing rejected for "${name}": invalid, expired or already used code.`, result: 'denied' });
        throw new HttpError(403, 'invalid_code', 'Pairing code is invalid, expired or already used.');
      }
      onChange({ type: 'device-paired', deviceId: device.id });
      send(res, 201, { deviceId: device.id, token: device.token, apiVersion: 1 });
      return;
    }

    const device = authenticate(req, ip);

    if (route === '/session' && method === 'POST') {
      const cookie = `${COOKIE}=${device.token}; HttpOnly; SameSite=Strict; Path=${API}; Max-Age=31536000${tls ? '; Secure' : ''}`;
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
      return;
    }
    if (route === '/session' && method === 'DELETE') {
      send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${API}; Max-Age=0${tls ? '; Secure' : ''}` });
      return;
    }
    if (libraryApi && await libraryApi.handle({ req, res, route, url, device, send, readJson, HttpError, isActive: () => Boolean(repo.authenticate(device.token)) })) return;

    if (route === '/device' && method === 'GET') {
      send(res, 200, { id: device.id, name: device.name, platform: device.platform, lastSyncAt: device.last_sync_at });
      return;
    }
    if (route === '/device' && method === 'DELETE') {
      const result = repo.revokeDevice(device.id);
      result.cancelled.forEach(id => importer.discardTemp(id));
      onChange({ type: 'device-revoked', deviceId: device.id });
      send(res, 200, { revoked: result.revoked });
      return;
    }
    if (route === '/sessions' && method === 'POST') {
      const key = String(req.headers['idempotency-key'] || '').trim();
      if (!key || key.length > 128) throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header is required.');
      const { session, created } = repo.createSession(device.id, key);
      onChange({ type: 'session' });
      send(res, created ? 201 : 200, serializeSession(session));
      return;
    }

    let match = route.match(/^\/sessions\/([\w-]{1,64})$/);
    if (match && method === 'GET') {
      const session = repo.getSession(match[1], device.id);
      if (!session) throw new HttpError(404, 'not_found', 'Session not found.');
      send(res, 200, serializeSession(session));
      return;
    }
    match = route.match(/^\/sessions\/([\w-]{1,64})\/complete$/);
    if (match && method === 'POST') {
      const session = repo.getSession(match[1], device.id);
      if (!session) throw new HttpError(404, 'not_found', 'Session not found.');
      repo.touchDeviceSync(device.id);
      onChange({ type: 'session' });
      send(res, 200, serializeSession(repo.completeSession(session.id)));
      return;
    }
    match = route.match(/^\/sessions\/([\w-]{1,64})\/assets$/);
    if (match && method === 'POST') {
      const session = repo.getSession(match[1], device.id);
      if (!session) throw new HttpError(404, 'not_found', 'Session not found.');
      if (session.status !== 'open') throw new HttpError(409, 'session_closed', 'Session is not open.');
      const body = await readJson(req);
      if (!Array.isArray(body.assets) || !body.assets.length || body.assets.length > MAX_BATCH) throw new HttpError(400, 'invalid_request', `assets must contain 1-${MAX_BATCH} items.`);
      const settings = repo.getSettings();
      const results = body.assets.map(meta => {
        try {
          const valid = importer.validateRegistration(meta || {}, settings);
          const { asset } = repo.registerAsset(device.id, session.id, valid);
          if (asset.state === 'discovered') repo.update(asset.id, { state: 'queued' });
          return { sourceAssetId: valid.sourceAssetId, asset: serializeAsset(repo.getAsset(asset.id)) };
        } catch (error) {
          if (error instanceof ImportError) return { sourceAssetId: String(meta?.sourceAssetId ?? ''), error: { code: error.code, message: error.message } };
          throw error;
        }
      });
      onChange({ type: 'assets' });
      send(res, 200, { assets: results });
      return;
    }
    if (route === '/assets/verify-delete' && method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.assets) || !body.assets.length || body.assets.length > MAX_BATCH) throw new HttpError(400, 'invalid_request', `assets must contain 1-${MAX_BATCH} items.`);
      const results = [];
      for (const item of body.assets) results.push(await verifyForDelete(device.id, item));
      send(res, 200, { assets: results });
      return;
    }
    match = route.match(/^\/assets\/([\w-]{1,64})\/deleted$/);
    if (match && method === 'POST') {
      const asset = repo.getDeviceAsset(match[1], device.id);
      if (!asset) throw new HttpError(404, 'not_found', 'Asset not found.');
      const body = await readJson(req);
      const check = await verifyForDelete(device.id, { assetId: asset.id, sha256: body.sha256 });
      if (!check.safeToDelete) throw new HttpError(409, 'not_safe_to_delete', `Cannot confirm deletion: ${check.reason}.`);
      repo.update(asset.id, { device_deleted_at: now() });
      onChange({ type: 'assets' });
      send(res, 200, serializeAsset(repo.getAsset(asset.id)));
      return;
    }
    match = route.match(/^\/assets\/([\w-]{1,64})$/);
    if (match && method === 'GET') {
      const asset = repo.getDeviceAsset(match[1], device.id);
      if (!asset) throw new HttpError(404, 'not_found', 'Asset not found.');
      send(res, 200, serializeAsset(asset));
      return;
    }
    match = route.match(/^\/assets\/([\w-]{1,64})\/content$/);
    if (match && (method === 'HEAD' || method === 'PUT')) {
      const asset = repo.getDeviceAsset(match[1], device.id);
      if (!asset) throw new HttpError(404, 'not_found', 'Asset not found.');
      if (method === 'HEAD') {
        res.writeHead(200, { 'Upload-Offset': String(asset.bytes_received), 'Upload-Length': String(asset.size), 'Upload-State': asset.state, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (['indexed', 'stored'].includes(asset.state)) { send(res, 200, serializeAsset(asset), { 'Upload-Offset': String(asset.size) }); return; }
      if (['cancelled', 'failed_permanent'].includes(asset.state)) throw new HttpError(409, 'asset_closed', `Asset is ${asset.state}.`);
      const offset = req.headers['upload-offset'] === undefined ? 0 : Number(req.headers['upload-offset']);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'invalid_offset', 'Upload-Offset must be a non-negative integer.');
      if (offset !== asset.bytes_received) {
        const error = new ImportError('offset_mismatch', `Expected offset ${asset.bytes_received}.`, 409);
        error.offset = asset.bytes_received;
        throw error;
      }
      const length = req.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || offset + Number(length) > asset.size)) throw new HttpError(413, 'size_exceeded', 'Body is larger than the declared asset size.');
      const settings = repo.getSettings();
      const counted = (async function* () { for await (const chunk of req) { onBytes(chunk.length); yield chunk; } })();
      let received;
      try {
        received = await importer.receive(asset, counted, offset, settings);
      } catch (error) {
        if (error instanceof ImportError && ['insufficient_storage', 'size_exceeded'].includes(error.code)) {
          error.code === 'size_exceeded' ? repo.failPermanent(asset.id, error.message) : repo.failRetryable(asset.id, error.message);
        } else if (!(error instanceof ImportError)) {
          if (repo.getAsset(asset.id).state === 'uploading') repo.update(asset.id, { state: 'queued' });
        }
        onChange({ type: 'assets' });
        throw error;
      }
      let current = repo.getAsset(asset.id);
      if (received.bytesReceived >= asset.size) current = await importer.finalize(asset.id);
      onChange({ type: 'assets' });
      send(res, 200, serializeAsset(current), { 'Upload-Offset': String(current.bytes_received) });
      return;
    }
    throw new HttpError(404, 'not_found', 'Unknown endpoint.');
  }

  function serveWeb(res, pathname) {
    const entry = WEB_FILES[pathname];
    if (!entry) return false;
    let body;
    try { body = fsSync.readFileSync(path.join(webDir, entry[0])); } catch { return false; }
    send(res, 200, body, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer'
    });
    return true;
  }

  async function handler(req, res) {
    const ip = req.socket.remoteAddress || '';
    try {
      if (!security.isPrivateAddress(ip)) throw new HttpError(403, 'forbidden_network', 'Only local-network clients are allowed.');
      const url = new URL(req.url, 'http://localhost');
      const browsing = /^\/api\/v1\/(libraries|me)(\/|$)/.test(url.pathname);
      if (!(browsing ? browseLimiter : apiLimiter).take(ip)) throw new HttpError(429, 'rate_limited', 'Too many requests.');
      if (url.pathname.startsWith(`${API}/`) || url.pathname === API) {
        await handleApi(req, res, url, ip);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveWeb(res, url.pathname)) return;
      throw new HttpError(404, 'not_found', 'Not found.');
    } catch (error) {
      fail(res, error);
    }
  }

  let server = null;

  function listen({ host, port, attempts = 10 }) {
    return new Promise((resolve, reject) => {
      let candidate = port;
      const attempt = () => {
        server = tls ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
        server.requestTimeout = 0;
        server.headersTimeout = 30000;
        server.keepAliveTimeout = 15000;
        server.once('error', error => {
          if (error.code === 'EADDRINUSE' && candidate < port + attempts - 1) { candidate += 1; attempt(); return; }
          reject(error);
        });
        server.listen(candidate, host, () => { server.removeAllListeners('error'); resolve({ host, port: server.address().port }); });
      };
      attempt();
    });
  }

  function close() {
    return new Promise(resolve => {
      if (!server) { resolve(); return; }
      const current = server;
      server = null;
      current.close(() => resolve());
      current.closeAllConnections?.();
    });
  }

  return { listen, close, handler };
}

module.exports = { createSyncServer, API };
