'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const indexStore = require('../index-store.js');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createRepo } = require('../electron/wifi-sync/repo.cjs');
const { openSyncDb, MIGRATION_COUNT } = require('../electron/wifi-sync/db.cjs');
const { createSyncServer } = require('../electron/wifi-sync/server.cjs');
const { createImporter, sanitizeFileName, classify, sniffMatches } = require('../electron/wifi-sync/importer.cjs');
const security = require('../electron/wifi-sync/security.cjs');

const JPEG = (size, seed = 1) => {
  const buffer = Buffer.alloc(size, seed);
  Buffer.from('ffd8ffe0', 'hex').copy(buffer);
  return buffer;
};

async function harness(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wifi-sync-'));
  const library = { id: 'a'.repeat(64), root: path.join(root, 'photos'), name: 'photos' };
  await fs.mkdir(library.root, { recursive: true });
  let index = indexStore.create('photos');
  const state = { failIndex: false, clock: Date.now() };
  const create = () => createService({
    dataDir: path.join(root, 'data'),
    resolveLibrary: id => (!id || id === library.id ? library : null),
    listLibraries: () => [library],
    findDuplicate: async (_libraryId, size, hash) => {
      if (state.beforeDuplicate) await state.beforeDuplicate();
      for (const entry of index.entries) {
        if (entry.missing || entry.size !== size) continue;
        const file = path.join(library.root, ...entry.path.split('/'));
        try {
          if (crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') === hash) return entry.path;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return null;
    },
    indexPhoto: async (_id, photo, hash) => {
      if (state.failIndex) throw new Error('index database offline');
      index = indexStore.addPhoto(index, photo, hash);
    },
    tls: options.tls === true,
    host: '127.0.0.1',
    now: () => state.clock,
    listAccounts: () => [{ id: 1, email: 'family@example.test', role: state.accountRole || 'editor', disabled_at: state.accountDisabled ? '2026-01-01' : null }]
  });
  let service = create();
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id, minFreeSpaceMB: 0, ...(options.settings || {}) });
  await service.start();
  const api = async (method, route, { token, body, headers = {}, raw } = {}) => {
    const response = await fetch(`${service.status().url}/api/v1${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, json, headers: response.headers };
  };
  const pair = async (name = 'Test Phone') => {
    const { code } = await service.createPairing();
    const result = await api('POST', '/pairing/claim', { body: { code, deviceName: name, platform: 'android' } });
    return { code, ...result };
  };
  const session = async token => (await api('POST', '/sessions', { token, headers: { 'Idempotency-Key': crypto.randomUUID() } })).json;
  const register = async (token, sessionId, assets) => (await api('POST', `/sessions/${sessionId}/assets`, { token, body: { assets } })).json.assets;
  const upload = (token, assetId, data, offset = 0) => api('PUT', `/assets/${assetId}/content`, { token, raw: data.subarray(offset), headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' } });
  const result = {
    root, library, api, pair, session, register, upload, state,
    index: () => index,
    setIndex(value) { index = value; },
    async restart() {
      await service.stop();
      service.close();
      service = create();
      await service.start();
    },
    async close() { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); }
  };
  Object.defineProperty(result, 'service', { get: () => service });
  return result;
}

async function pairedDevice(h) {
  const paired = await h.pair();
  assert.equal(paired.status, 201);
  return paired.json.token;
}

test('family ownership and device policy gate native registration, resume and restart', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const repo = h.service.repo;
    const device = repo.authenticate(token);
    repo.setSettings({ familyEnabled: true });
    assert.equal((await h.api('POST', '/sessions', { token, headers: { 'Idempotency-Key': 'unassigned' } })).status, 403);
    const profileId = repo.family.saveProfile({ accountId: 1, name: 'Family', role: 'viewer', enabled: true });
    const policy = { profileId, uploadEnabled: true, allowImages: true, allowVideos: false, maxFileSizeMB: 1 };
    repo.family.saveDevice(device.id, policy);
    assert.equal((await h.api('POST', '/sessions', { token, headers: { 'Idempotency-Key': 'viewer' } })).status, 403);
    repo.family.saveProfile({ id: profileId, accountId: 1, name: 'Family', role: 'contributor', enabled: true });
    const session = await h.session(token);
    const [large, video, photo] = await h.register(token, session.id, [
      { sourceAssetId: 'large', filename: 'large.jpg', size: 2 * 1024 * 1024, mediaType: 'image/jpeg' },
      { sourceAssetId: 'video', filename: 'video.mp4', size: 64, mediaType: 'video/mp4' },
      { sourceAssetId: 'photo', filename: 'photo.jpg', size: 64, mediaType: 'image/jpeg' }
    ]);
    assert.equal(large.error.code, 'upload_policy');
    assert.equal(video.error.code, 'upload_policy');
    assert.ok(photo.asset.id);
    assert.equal((await h.api('PUT', `/assets/${photo.asset.id}/content`, { token, raw: JPEG(64).subarray(0, 20) })).status, 200);
    repo.family.saveDevice(device.id, { ...policy, uploadEnabled: false });
    repo.family.setGrant(profileId, h.library.id, 'shared-album', true);
    assert.equal(repo.family.signIn(device.id, { id: 1, email: 'family@example.test' }), true);
    assert.equal((await h.upload(token, photo.asset.id, JPEG(64), 20)).status, 403);
    await h.restart();
    assert.equal(h.service.repo.getSettings().familyEnabled, true);
    assert.equal(h.service.repo.family.profiles()[0].id, profileId);
    assert.deepEqual(h.service.repo.family.allowedAlbums(profileId, h.library.id), ['shared-album']);
    assert.equal(h.service.repo.family.context(device.id).signedIn, true);
    assert.equal((await h.upload(token, photo.asset.id, JPEG(64), 20)).status, 403);
    h.service.repo.family.saveDevice(device.id, policy);
    h.state.accountDisabled = true;
    assert.equal((await h.upload(token, photo.asset.id, JPEG(64), 20)).status, 403);
    h.state.accountDisabled = false;
    h.state.accountRole = 'viewer';
    assert.equal((await h.upload(token, photo.asset.id, JPEG(64), 20)).status, 403);
    h.state.accountRole = 'editor';
    assert.equal((await h.upload(token, photo.asset.id, JPEG(64), 20)).status, 200);
    assert.equal(h.index().entries.length, 1);
    await h.service.revokeDevice(device.id);
    assert.equal((await h.api('GET', '/device', { token })).status, 401);
  } finally { await h.close(); }
});

test('family devices sharing one owner keep independent uploads, credentials and sync histories', async () => {
  const h = await harness();
  try {
    const first = (await h.pair('Family phone')).json;
    const second = (await h.pair('Family phone')).json;
    const repo = h.service.repo;
    const profileId = repo.family.saveProfile({ accountId: 1, name: 'Family', role: 'contributor', enabled: true });
    const policy = { profileId, uploadEnabled: true, allowImages: true, allowVideos: true, maxFileSizeMB: 100 };
    for (const device of [first, second]) repo.family.saveDevice(device.deviceId, policy);
    repo.setSettings({ familyEnabled: true });
    const sessions = await Promise.all([first, second].map(device => h.api('POST', '/sessions', {
      token: device.token, headers: { 'Idempotency-Key': 'same-session-key' }
    })));
    assert.ok(sessions.every(result => result.status === 201));
    const [a, b] = sessions.map(result => result.json);
    assert.notEqual(a.id, b.id);
    const meta = { sourceAssetId: 'same-camera-id', filename: 'photo.jpg', mediaType: 'image/jpeg', size: 256 };
    const [one, two] = await Promise.all([
      h.register(first.token, a.id, [meta]), h.register(second.token, b.id, [meta])
    ]);
    const assetA = one[0].asset.id;
    const assetB = two[0].asset.id;
    assert.notEqual(assetA, assetB);
    for (const [device, otherSession, otherAsset] of [[first, b.id, assetB], [second, a.id, assetA]]) {
      assert.equal((await h.api('GET', `/sessions/${otherSession}`, { token: device.token })).status, 404);
      assert.equal((await h.api('GET', `/assets/${otherAsset}`, { token: device.token })).status, 404);
      assert.equal((await h.upload(device.token, otherAsset, JPEG(256))).status, 404);
    }
    repo.family.saveDevice(first.deviceId, { ...policy, uploadEnabled: false });
    assert.equal((await h.upload(first.token, assetA, JPEG(256, 1))).status, 403);
    assert.equal((await h.upload(second.token, assetB, JPEG(256, 2))).json.state, 'indexed');
    await h.api('POST', `/sessions/${b.id}/complete`, { token: second.token });
    const secondSyncAt = h.state.clock;
    h.state.clock += 1000;
    repo.family.saveDevice(first.deviceId, policy);
    assert.equal((await h.upload(first.token, assetA, JPEG(256, 1))).json.state, 'indexed');
    await h.api('POST', `/sessions/${a.id}/complete`, { token: first.token });
    const rows = [repo.getAsset(assetA), repo.getAsset(assetB)];
    assert.notEqual(rows[0].library_path, rows[1].library_path);
    assert.equal(h.index().entries.length, 2);
    assert.equal(repo.authenticate(first.token).last_sync_at, h.state.clock);
    assert.equal(repo.authenticate(second.token).last_sync_at, secondSyncAt);
    await h.service.revokeDevice(first.deviceId);
    await h.restart();
    assert.equal((await h.upload(first.token, assetA, JPEG(256, 1))).status, 401);
    assert.equal((await h.api('GET', `/sessions/${b.id}`, { token: second.token })).json.status, 'completed');
    assert.equal((await h.api('GET', `/assets/${assetB}`, { token: second.token })).json.state, 'indexed');
    assert.equal(h.service.repo.getSession(a.id, first.deviceId).status, 'completed');
    assert.equal(h.service.repo.getAsset(assetA).device_id, first.deviceId);
    assert.equal(h.service.repo.getAsset(assetB).device_id, second.deviceId);
  } finally { await h.close(); }
});

test('in-flight revocation stops later chunks without reviving cancelled jobs', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const repo = h.service.repo;
    const device = repo.authenticate(token);
    const session = await h.session(token);
    const [registered] = await h.register(token, session.id, [{ sourceAssetId: 'active', filename: 'active.jpg', size: 64, mediaType: 'image/jpeg' }]);
    const asset = repo.getAsset(registered.asset.id);
    const stream = (async function* () {
      yield JPEG(64).subarray(0, 16);
      repo.revokeDevice(device.id);
      yield JPEG(64).subarray(16);
    })();
    await assert.rejects(h.service.importer.receive(asset, stream, 0, repo.getSettings()), error => error.code === 'upload_policy');
    assert.equal(repo.getAsset(asset.id).bytes_received, 16);
    assert.equal(repo.getAsset(asset.id).state, 'cancelled');
    assert.equal((await h.service.importer.finalize(asset.id)).state, 'cancelled');
    assert.equal(h.index().entries.length, 0);
  } finally { await h.close(); }
});

test('in-flight policy pauses preserve offsets and do not accept subsequent chunks', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const repo = h.service.repo;
    const device = repo.authenticate(token);
    const session = await h.session(token);
    const [registered] = await h.register(token, session.id, [{ sourceAssetId: 'active', filename: 'active.jpg', size: 64, mediaType: 'image/jpeg' }]);
    const asset = repo.getAsset(registered.asset.id);
    const policy = { profileId: null, uploadEnabled: false, allowImages: true, allowVideos: true, maxFileSizeMB: 4096 };
    const stream = (async function* () {
      yield JPEG(64).subarray(0, 16);
      repo.family.saveDevice(device.id, policy);
      yield JPEG(64).subarray(16);
    })();
    await assert.rejects(h.service.importer.receive(asset, stream, 0, repo.getSettings()), error => error.code === 'upload_policy');
    assert.equal(repo.getAsset(asset.id).bytes_received, 16);
    assert.equal(repo.getAsset(asset.id).state, 'queued');
    repo.family.saveDevice(device.id, { ...policy, uploadEnabled: true });
    assert.equal((await h.upload(token, asset.id, JPEG(64), 16)).status, 200);
    assert.equal(h.index().entries.length, 1);
  } finally { await h.close(); }
});

test('revocation during verification cannot place a new original or revive the job', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const repo = h.service.repo;
    const device = repo.authenticate(token);
    const session = await h.session(token);
    const [registered] = await h.register(token, session.id, [{ sourceAssetId: 'verify', filename: 'verify.jpg', size: 64, mediaType: 'image/jpeg' }]);
    h.state.beforeDuplicate = () => repo.revokeDevice(device.id);
    const result = await h.upload(token, registered.asset.id, JPEG(64));
    assert.equal(result.json.state, 'cancelled');
    assert.equal(repo.getAsset(registered.asset.id).state, 'cancelled');
    assert.equal(h.index().entries.length, 0);
    assert.deepEqual(await fs.readdir(h.library.root), []);
  } finally { await h.close(); }
});

test('migration 5 preserves a verified pre-family SQLite snapshot and rejects future schemas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-migrate-'));
  const file = path.join(root, 'sync.db');
  let db;
  try {
    db = openSyncDb(file);
    const repo = createRepo(db);
    const code = repo.createPairingCode(120);
    const device = repo.claimPairingCode(code.code, 'Existing phone', 'android');
    db.exec(`DROP TABLE family_logins; DROP TABLE album_grants;
      ALTER TABLE devices DROP COLUMN profile_id; ALTER TABLE devices DROP COLUMN upload_enabled;
      ALTER TABLE devices DROP COLUMN allow_images; ALTER TABLE devices DROP COLUMN allow_videos;
      ALTER TABLE devices DROP COLUMN max_file_size_mb; DROP TABLE family_profiles; PRAGMA user_version=4;`);
    db.close(); db = null;
    db = openSyncDb(file);
    assert.equal(createRepo(db).authenticate(device.token).name, 'Existing phone');
    assert.equal(createRepo(db).getSettings().familyEnabled, false);
    const snapshots = (await fs.readdir(root)).filter(name => name.includes('.pre-family-') && name.endsWith('.db'));
    assert.equal(snapshots.length, 1);
    const snapshot = new (require('node:sqlite').DatabaseSync)(path.join(root, snapshots[0]), { readOnly: true });
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(snapshot.prepare('SELECT name FROM devices').get().name, 'Existing phone');
    } finally { snapshot.close(); }
    db.exec(`PRAGMA user_version=${MIGRATION_COUNT + 1}`);
    db.close(); db = null;
    assert.throws(() => openSyncDb(file), /newer version/);
  } finally { if (db) db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('pairing code is single use and the device token works', async () => {
  const h = await harness();
  try {
    const first = await h.pair();
    assert.equal(first.status, 201);
    const reuse = await h.api('POST', '/pairing/claim', { body: { code: first.code, deviceName: 'Other', platform: 'ios' } });
    assert.equal(reuse.status, 403);
    assert.equal((await h.api('GET', '/device', { token: first.json.token })).status, 200);
  } finally { await h.close(); }
});

test('multiple devices receive independent credentials', async () => {
  const h = await harness();
  try {
    const first = await h.pair('Phone one');
    const second = await h.pair('Phone two');
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.json.token, second.json.token);
    assert.equal((await h.api('GET', '/device', { token: first.json.token })).json.name, 'Phone one');
    assert.equal((await h.api('GET', '/device', { token: second.json.token })).json.name, 'Phone two');
  } finally { await h.close(); }
});

test('phone installation serves a valid manifest, icons, worker and unchanged pairing flow', async () => {
  const h = await harness();
  try {
    const base = h.service.status().url;
    const response = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /manifest\+json/);
    const manifest = await response.json();
    assert.equal(manifest.id, '/app');
    assert.equal(manifest.start_url, '/app');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    for (const size of [180, 192, 512]) {
      const icon = await fetch(`${base}/icon-${size}.png`);
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await icon.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
    }
    assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
    for (const route of ['/app', '/', '/pair', '/device', '/install.js', '/install.css', '/sw.js']) {
      const asset = await fetch(base + route);
      assert.equal(asset.status, 200, route);
      assert.match(asset.headers.get('content-security-policy'), /worker-src 'self'/);
      if (route === '/sw.js') assert.match(asset.headers.get('content-type'), /javascript/);
      if (route === '/app') assert.match(await asset.text(), /phone-pwa-install/);
    }
    const pairing = await h.service.createPairing();
    assert.equal(new URL(pairing.link).origin, base);
    assert.equal(new URL(pairing.link).pathname, '/app');
    assert.match(pairing.qr, /^data:image\/png;base64,/);
    const code = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('code');
    const claimed = await h.api('POST', '/pairing/claim', { body: { code, deviceName: 'Installed phone', platform: 'web' } });
    assert.equal(claimed.status, 201);
    assert.equal((await h.api('GET', '/device', { token: claimed.json.token })).status, 200);
  } finally { await h.close(); }
});

test('expired pairing code is rejected', async () => {
  const h = await harness();
  try {
    const { code } = await h.service.createPairing();
    h.state.clock += 121 * 1000;
    const result = await h.api('POST', '/pairing/claim', { body: { code, deviceName: 'Late', platform: 'android' } });
    assert.equal(result.status, 403);
  } finally { await h.close(); }
});

test('pairing attempts are rate limited and codes are stored hashed', async () => {
  const h = await harness();
  try {
    const { code } = await h.service.createPairing();
    const stored = h.service.repo.db.prepare('SELECT code_hash FROM pairing_codes').all().map(row => row.code_hash);
    assert.ok(stored.every(value => !value.includes(security.normalizeCode(code))));
    let limited = 0;
    for (let i = 0; i < 15; i += 1) {
      const result = await h.api('POST', '/pairing/claim', { body: { code: 'WRONGCODE', deviceName: 'x', platform: 'x' } });
      if (result.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'expected 429 after repeated failures');
  } finally { await h.close(); }
});

test('requests without a valid token are rejected and revocation takes effect immediately', async () => {
  const h = await harness();
  try {
    assert.equal((await h.api('GET', '/device')).status, 401);
    assert.equal((await h.api('GET', '/device', { token: 'x'.repeat(43) })).status, 401);
    const token = await pairedDevice(h);
    const [device] = h.service.repo.listDevices();
    await h.service.revokeDevice(device.id);
    assert.equal((await h.api('GET', '/device', { token })).status, 401);
  } finally { await h.close(); }
});

test('ping is public and reports the API version', async () => {
  const h = await harness();
  try {
    const result = await h.api('GET', '/ping');
    assert.equal(result.status, 200);
    assert.equal(result.json.apiVersion, 1);
  } finally { await h.close(); }
});

test('upload goes discovered -> queued -> stored -> indexed and lands in the library index', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(5000);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'IMG_1', filename: 'IMG_1.jpg', mediaType: 'image/jpeg', size: data.length, capturedAt: Date.UTC(2024, 4, 3) }]);
    assert.equal(asset.state, 'queued');
    const result = await h.upload(token, asset.id, data);
    assert.equal(result.status, 200);
    assert.equal(result.json.state, 'indexed');
    assert.equal(result.json.status, 'imported');
    const row = h.service.repo.getAsset(asset.id);
    assert.equal(row.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.match(row.library_path, /^Wi-Fi Sync\/Test Phone\/2024\/05\/IMG_1\.jpg$/);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...row.library_path.split('/'))), data);
    assert.ok(h.index().entries.some(entry => entry.path === row.library_path && entry.contentHash === row.sha256));
    const leftovers = (await fs.readdir(path.join(h.root, 'data', 'incoming'))).filter(name => name.endsWith('.part'));
    assert.equal(leftovers.length, 0);
  } finally { await h.close(); }
});

test('uploaded videos are registered in the existing library index', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = Buffer.alloc(4096, 3);
    Buffer.from('00000018667479706d703432', 'hex').copy(data);
    const capturedAt = Date.UTC(2024, 4, 3);
    const [{ asset }] = await h.register(token, session.id, [{
      sourceAssetId: 'VIDEO_1', filename: 'clip.mp4', mediaType: 'video/mp4',
      size: data.length, capturedAt
    }]);
    const result = await h.upload(token, asset.id, data);
    assert.equal(result.json.status, 'imported');
    const entry = h.index().entries.find(item => item.path === result.json.libraryPath);
    assert.ok(entry);
    assert.equal(entry.extension, 'mp4');
    assert.equal(entry.dateTaken, new Date(capturedAt).toISOString());
  } finally { await h.close(); }
});

test('sync accepts all video formats supported by the desktop library', () => {
  const headers = {
    mp4: Buffer.from('00000018667479706d703432', 'hex'),
    m4v: Buffer.from('00000018667479706d703432', 'hex'),
    mov: Buffer.from('000000186674797071742020', 'hex'),
    '3gp': Buffer.from('000000186674797033677034', 'hex'),
    webm: Buffer.from('1a45dfa3', 'hex'),
    mkv: Buffer.from('1a45dfa3', 'hex'),
    ogv: Buffer.from('4f676753', 'hex'),
    avi: Buffer.from('524946460000000041564920', 'hex')
  };
  for (const [extension, header] of Object.entries(headers)) {
    assert.equal(classify(`clip.${extension}`, `video/${extension}`).kind, 'video');
    assert.equal(sniffMatches(header, extension), true);
  }
});

test('repeated registration and repeated upload are idempotent', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const key = 'same-key';
    const a = await h.api('POST', '/sessions', { token, headers: { 'Idempotency-Key': key } });
    const b = await h.api('POST', '/sessions', { token, headers: { 'Idempotency-Key': key } });
    assert.equal(a.json.id, b.json.id);
    const data = JPEG(3000, 7);
    const meta = { sourceAssetId: 'X1', filename: 'x.jpg', mediaType: 'image/jpeg', size: data.length };
    const [first] = await h.register(token, a.json.id, [meta]);
    const [second] = await h.register(token, a.json.id, [meta]);
    assert.equal(first.asset.id, second.asset.id);
    await h.upload(token, first.asset.id, data);
    const again = await h.upload(token, first.asset.id, data);
    assert.equal(again.status, 200);
    assert.equal(h.service.repo.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
    assert.equal(h.index().entries.length, 1);
  } finally { await h.close(); }
});

test('identical content from another asset is detected as a duplicate and not stored twice', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(2000, 9);
    const regs = await h.register(token, session.id, [
      { sourceAssetId: 'A', filename: 'a.jpg', mediaType: 'image/jpeg', size: data.length },
      { sourceAssetId: 'B', filename: 'b.jpg', mediaType: 'image/jpeg', size: data.length }
    ]);
    await h.upload(token, regs[0].asset.id, data);
    const dup = await h.upload(token, regs[1].asset.id, data);
    assert.equal(dup.json.duplicateOf, regs[0].asset.id);
    assert.equal(h.index().entries.length, 1);
  } finally { await h.close(); }
});

test('duplicate detection verifies originals instead of trusting stale sync history', async () => {
  const h = await harness();
  try {
    const first = await pairedDevice(h);
    const second = await pairedDevice(h);
    const sessionA = await h.session(first);
    const sessionB = await h.session(second);
    const data = JPEG(2000, 9);
    const meta = { sourceAssetId: 'same-id', filename: 'photo.jpg', mediaType: 'image/jpeg', size: data.length };
    const [{ asset: old }] = await h.register(first, sessionA.id, [meta]);
    await h.upload(first, old.id, data);
    const oldRow = h.service.repo.getAsset(old.id);
    const original = path.join(h.library.root, ...oldRow.library_path.split('/'));
    await fs.writeFile(original, JPEG(data.length, 3));
    const [{ asset: replacement }] = await h.register(second, sessionB.id, [meta]);
    const uploaded = await h.upload(second, replacement.id, data);
    assert.equal(uploaded.json.state, 'indexed');
    assert.equal(uploaded.json.duplicateOf, null);
    assert.notEqual(uploaded.json.libraryPath, oldRow.library_path);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...uploaded.json.libraryPath.split('/'))), data);
    await fs.rm(original);
    const [{ asset: third }] = await h.register(first, sessionA.id, [{ ...meta, sourceAssetId: 'another-id' }]);
    const duplicate = await h.upload(first, third.id, data);
    assert.equal(duplicate.json.duplicateOf, replacement.id);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    const verification = await h.api('POST', '/assets/verify-delete', { token: first, body: { assets: [{ assetId: third.id, sha256: digest }] } });
    assert.equal(verification.json.assets[0].safeToDelete, true);
  } finally { await h.close(); }
});

test('disconnect during verification retains upload bytes and library metadata until reconnect', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(2000, 9);
    const meta = { filename: 'photo.jpg', mediaType: 'image/jpeg', size: data.length };
    const [{ asset: old }, { asset: pending }] = await h.register(token, session.id, [
      { ...meta, sourceAssetId: 'old' }, { ...meta, sourceAssetId: 'pending' }
    ]);
    await h.upload(token, old.id, data);
    const index = h.index();
    index.albums = [{ id: 'family', name: 'Family' }];
    index.entries[0].metadata.albumIds = ['family'];
    index.entries[0].metadata.favorite = true;
    const before = structuredClone(index);
    const importer = h.service.importer;
    await importer.receive(h.service.repo.getAsset(pending.id), (async function* () { yield data; })(), 0, h.service.repo.getSettings());
    const disconnected = path.join(h.root, 'disconnected-photos');
    await fs.rename(h.library.root, disconnected);
    const failed = await importer.finalize(pending.id);
    assert.equal(failed.state, 'failed_retryable');
    assert.equal(failed.duplicate_of, null);
    assert.deepEqual(await fs.readFile(importer.tempPath(pending.id)), data);
    assert.deepEqual(h.index(), before);
    await assert.rejects(() => fs.access(h.library.root), { code: 'ENOENT' });
    await h.restart();
    assert.equal(h.service.repo.getAsset(pending.id).state, 'failed_retryable');
    assert.deepEqual(await fs.readFile(h.service.importer.tempPath(pending.id)), data);
    await fs.rename(disconnected, h.library.root);
    const recovered = await h.service.retryAsset(pending.id);
    assert.equal(recovered.state, 'indexed');
    assert.equal(recovered.duplicate_of, old.id);
    assert.deepEqual(h.index(), before);
    await assert.rejects(() => fs.access(h.service.importer.tempPath(pending.id)), { code: 'ENOENT' });
  } finally { await h.close(); }
});

test('uploads to disconnected storage report a retryable error without recreating the root', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'offline', filename: 'photo.jpg', mediaType: 'image/jpeg', size: 256 }]);
    const disconnected = path.join(h.root, 'disconnected-photos');
    await fs.rename(h.library.root, disconnected);
    const result = await h.upload(token, asset.id, JPEG(256));
    assert.equal(result.status, 503);
    assert.equal(result.json.error.code, 'storage_unavailable');
    assert.equal(h.service.repo.getAsset(asset.id).state, 'failed_retryable');
    assert.equal(h.service.repo.getAsset(asset.id).bytes_received, 0);
    await assert.rejects(() => fs.access(h.library.root), { code: 'ENOENT' });
    await fs.rename(disconnected, h.library.root);
    assert.equal((await h.upload(token, asset.id, JPEG(256))).json.state, 'indexed');
    assert.equal(h.index().entries.length, 1);
  } finally { await h.close(); }
});

test('an upload matching an existing library file is recorded without another copy or index entry', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(2400, 11);
    const relPath = 'Camera/already-here.jpg';
    const file = path.join(h.library.root, ...relPath.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    const stat = await fs.stat(file);
    h.setIndex(indexStore.addPhoto(h.index(), { path: relPath, size: stat.size, lastModified: stat.mtimeMs }));
    const [{ asset }] = await h.register(token, session.id, [{
      sourceAssetId: 'duplicate-existing', filename: 'copy.jpg', mediaType: 'image/jpeg', size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex')
    }]);
    const result = await h.upload(token, asset.id, data);
    assert.equal(result.json.status, 'duplicate');
    assert.equal(result.json.duplicateOf, relPath);
    assert.equal(result.json.libraryPath, relPath);
    assert.deepEqual(await fs.readFile(file), data);
    assert.equal(h.index().entries.length, 1);
    assert.equal(h.service.repo.getAsset(asset.id).source_asset_id, 'duplicate-existing');
  } finally { await h.close(); }
});

test('interrupted upload resumes from the stored offset', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(10000, 3);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'R', filename: 'r.jpg', mediaType: 'image/jpeg', size: data.length }]);
    const partial = await h.upload(token, asset.id, data.subarray(0, 4000));
    assert.equal(partial.status, 200);
    assert.equal(partial.json.bytesReceived, 4000);
    const head = await h.api('HEAD', `/assets/${asset.id}/content`, { token });
    assert.equal(head.headers.get('upload-offset'), '4000');
    const wrong = await h.upload(token, asset.id, data, 1000);
    assert.equal(wrong.status, 409);
    const done = await h.upload(token, asset.id, data, 4000);
    assert.equal(done.json.state, 'indexed');
    const row = h.service.repo.getAsset(asset.id);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...row.library_path.split('/'))), data);
  } finally { await h.close(); }
});

test('a dropped network connection preserves the received bytes for resume', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(20000, 13);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'network-drop', filename: 'partial.jpg', mediaType: 'image/jpeg', size: data.length }]);
    const request = http.request(`${h.service.status().url}/api/v1/assets/${asset.id}/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Content-Length': String(data.length) }
    });
    const closed = new Promise(resolve => {
      request.once('error', resolve);
      request.once('close', resolve);
      request.write(data.subarray(0, 5000));
      setTimeout(() => request.destroy(), 30);
    });
    await closed;
    for (let attempt = 0; attempt < 100 && h.service.repo.getAsset(asset.id).bytes_received === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const head = await h.api('HEAD', `/assets/${asset.id}/content`, { token });
    const offset = Number(head.headers.get('upload-offset'));
    assert.ok(offset > 0 && offset < data.length);
    const completed = await h.upload(token, asset.id, data, offset);
    assert.equal(completed.json.status, 'imported');
    const row = h.service.repo.getAsset(asset.id);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...row.library_path.split('/'))), data);
  } finally { await h.close(); }
});

test('server restart preserves an interrupted upload and its history', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(12000, 17);
    const expected = crypto.createHash('sha256').update(data).digest('hex');
    const [{ asset }] = await h.register(token, session.id, [{
      sourceAssetId: 'restart', filename: 'restart.jpg', mediaType: 'image/jpeg', size: data.length, sha256: expected
    }]);
    await h.upload(token, asset.id, data.subarray(0, 3500));
    await h.restart();
    const head = await h.api('HEAD', `/assets/${asset.id}/content`, { token });
    assert.equal(head.headers.get('upload-offset'), '3500');
    const completed = await h.upload(token, asset.id, data, 3500);
    assert.equal(completed.json.status, 'imported');
    assert.equal(h.service.repo.getAsset(asset.id).source_asset_id, 'restart');
    assert.equal(h.service.repo.getAsset(asset.id).expected_sha256, expected);
  } finally { await h.close(); }
});

test('restart recovery reconciles offsets and finishes stored-but-unindexed files', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(6000, 4);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'Z', filename: 'z.jpg', mediaType: 'image/jpeg', size: data.length }]);
    await h.upload(token, asset.id, data.subarray(0, 2500));
    h.service.repo.update(asset.id, { bytes_received: 9999, state: 'uploading' });
    await h.service.importer.recover();
    let row = h.service.repo.getAsset(asset.id);
    assert.equal(row.bytes_received, 2500);
    assert.equal(row.state, 'queued');

    h.state.failIndex = true;
    await h.upload(token, asset.id, data, 2500);
    row = h.service.repo.getAsset(asset.id);
    assert.equal(row.state, 'failed_retryable');
    assert.ok(row.library_path, 'file must stay stored when indexing fails');
    assert.equal(h.index().entries.length, 0);

    h.state.failIndex = false;
    const storedFile = path.join(h.library.root, ...row.library_path.split('/'));
    const storedBytes = await fs.readFile(storedFile);
    const corrupted = Buffer.from(storedBytes);
    corrupted[100] ^= 0xff;
    await fs.writeFile(storedFile, corrupted);
    h.service.repo.update(asset.id, { state: 'stored' });
    await h.service.importer.recover();
    assert.equal(h.service.repo.getAsset(asset.id).state, 'failed_retryable');
    assert.equal(h.index().entries.length, 0);
    await fs.writeFile(storedFile, storedBytes);
    await h.service.retryAsset(asset.id);
    assert.equal(h.service.repo.getAsset(asset.id).state, 'indexed');
    assert.equal(h.index().entries.length, 1);
  } finally { await h.close(); }
});

test('retryable failures can be retried manually and become permanent after the retry cap', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(1500, 5);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'F', filename: 'f.jpg', mediaType: 'image/jpeg', size: data.length }]);
    h.state.failIndex = true;
    await h.upload(token, asset.id, data);
    assert.equal(h.service.repo.getAsset(asset.id).state, 'failed_retryable');
    h.state.failIndex = false;
    await h.service.retryAsset(asset.id);
    assert.equal(h.service.repo.getAsset(asset.id).state, 'indexed');
    const other = h.service.repo.registerAsset(h.service.repo.listDevices()[0].id, session.id, { sourceAssetId: 'cap', filename: 'c.jpg', mediaType: 'image/jpeg', kind: 'image', size: 10, capturedAt: null }).asset;
    for (let i = 0; i < 6; i += 1) h.service.repo.failRetryable(other.id, 'boom');
    assert.equal(h.service.repo.getAsset(other.id).state, 'failed_permanent');
  } finally { await h.close(); }
});

test('invalid type, wrong content, and oversize files are rejected', async () => {
  const h = await harness({ settings: { maxFileSizeMB: 1 } });
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const regs = await h.register(token, session.id, [
      { sourceAssetId: 'e', filename: 'virus.exe', mediaType: 'application/octet-stream', size: 100 },
      { sourceAssetId: 'big', filename: 'big.jpg', mediaType: 'image/jpeg', size: 2 * 1024 * 1024 },
      { sourceAssetId: 'fake', filename: 'fake.png', mediaType: 'image/png', size: 100 },
      { sourceAssetId: 'mime', filename: 'm.jpg', mediaType: 'text/html', size: 100 }
    ]);
    assert.equal(regs[0].error.code, 'unsupported_type');
    assert.equal(regs[1].error.code, 'too_large');
    assert.equal(regs[3].error.code, 'unsupported_type');
    const fake = await h.upload(token, regs[2].asset.id, Buffer.from('<html>not a png at all.............................................................................................</html>').subarray(0, 100));
    assert.equal(fake.json.state, 'failed_permanent');
    const tooMuch = await h.register(token, session.id, [{ sourceAssetId: 'short', filename: 's.jpg', mediaType: 'image/jpeg', size: 100 }]);
    const over = await h.upload(token, tooMuch[0].asset.id, JPEG(500));
    assert.equal(over.status, 413);
  } finally { await h.close(); }
});

test('a corrupt upload fails when its declared SHA-256 does not match', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const original = JPEG(2000, 21);
    const corrupt = Buffer.from(original);
    corrupt[100] ^= 0xff;
    const expected = crypto.createHash('sha256').update(original).digest('hex');
    const [{ asset }] = await h.register(token, session.id, [{
      sourceAssetId: 'corrupt', filename: 'corrupt.jpg', mediaType: 'image/jpeg', size: corrupt.length, sha256: expected
    }]);
    const result = await h.upload(token, asset.id, corrupt);
    assert.equal(result.json.state, 'failed_permanent');
    assert.match(result.json.error, /SHA-256/);
    assert.equal(h.index().entries.length, 0);
    assert.equal((await fs.readdir(h.library.root)).length, 0);
  } finally { await h.close(); }
});

test('path traversal in file names and device names cannot escape the library', async () => {
  assert.equal(sanitizeFileName('../../evil.jpg'), 'evil.jpg');
  assert.equal(sanitizeFileName('..\\..\\evil.jpg'), 'evil.jpg');
  assert.match(sanitizeFileName('CON.jpg'), /^photo_CON\.jpg$/);
  const h = await harness();
  try {
    const paired = await h.pair('../../../Windows');
    const token = paired.json.token;
    const session = await h.session(token);
    const data = JPEG(1200, 6);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 't', filename: '..\\..\\escape.jpg', mediaType: 'image/jpeg', size: data.length }]);
    await h.upload(token, asset.id, data);
    const row = h.service.repo.getAsset(asset.id);
    assert.ok(!row.library_path.includes('..'));
    const absolute = path.resolve(h.library.root, ...row.library_path.split('/'));
    assert.ok(absolute.startsWith(path.resolve(h.library.root) + path.sep));
    await fs.access(absolute);
  } finally { await h.close(); }
});

test('same file name never overwrites an existing file', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const one = JPEG(1000, 1);
    const two = JPEG(1000, 2);
    const regs = await h.register(token, session.id, [
      { sourceAssetId: '1', filename: 'same.jpg', mediaType: 'image/jpeg', size: 1000 },
      { sourceAssetId: '2', filename: 'same.jpg', mediaType: 'image/jpeg', size: 1000 }
    ]);
    await h.upload(token, regs[0].asset.id, one);
    await h.upload(token, regs[1].asset.id, two);
    const [a, b] = regs.map(item => h.service.repo.getAsset(item.asset.id).library_path);
    assert.notEqual(a, b);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...a.split('/'))), one);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...b.split('/'))), two);
  } finally { await h.close(); }
});

test('insufficient disk space is reported without writing data', async () => {
  const h = await harness();
  try {
    const importer = createImporter({
      repo: h.service.repo, tempDir: path.join(h.root, 'tmp'), resolveLibrary: () => h.library, indexPhoto: async () => {},
      statfs: async () => ({ bavail: 1, bsize: 1024 })
    });
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'd', filename: 'd.jpg', mediaType: 'image/jpeg', size: 5000 }]);
    const row = h.service.repo.getAsset(asset.id);
    await assert.rejects(() => importer.receive(row, (async function* () { yield JPEG(5000); })(), 0, { ...h.service.repo.getSettings(), minFreeSpaceMB: 0 }), { code: 'insufficient_storage' });
    await assert.rejects(() => fs.access(importer.tempPath(asset.id)));
  } finally { await h.close(); }
});

test('revoking a device cancels its pending assets', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'p', filename: 'p.jpg', mediaType: 'image/jpeg', size: 100 }]);
    const [device] = h.service.repo.listDevices();
    await h.service.revokeDevice(device.id);
    assert.equal(h.service.repo.getAsset(asset.id).state, 'cancelled');
  } finally { await h.close(); }
});

test('migrations are versioned and rerunning them is safe', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wifi-db-')), 'x.db');
  const first = openSyncDb(file);
  assert.equal(first.prepare('PRAGMA user_version').get().user_version, MIGRATION_COUNT);
  const columns = first.prepare('PRAGMA table_info(assets)').all().map(column => column.name);
  assert.ok(columns.includes('expected_sha256'));
  assert.ok(columns.includes('duplicate_library_path'));
  first.close();
  const second = openSyncDb(file);
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, MIGRATION_COUNT);
  second.close();
});

test('private-network check rejects public addresses', () => {
  assert.ok(security.isPrivateAddress('192.168.1.20'));
  assert.ok(security.isPrivateAddress('::ffff:10.0.0.5'));
  assert.ok(!security.isPrivateAddress('8.8.8.8'));
  assert.ok(!security.isPrivateAddress('172.32.0.1'));
  for (const address of ['0.0.0.0', '::', '8.8.8.8', '100.64.0.1', 'localhost', 'fd-server.example', 'fc.example', 'fe80:not-an-ip', '']) {
    assert.equal(security.isPrivateAddress(address), false, address);
  }
  for (const address of ['::1', 'fd12::1', 'fc00::1', 'fe80::1']) {
    assert.equal(security.isPrivateAddress(address), true, address);
  }
});

test('listener rejects public, wildcard and hostname bindings before opening a socket', async () => {
  const db = openSyncDb(':memory:');
  const server = createSyncServer({ repo: createRepo(db), importer: {} });
  try {
    for (const host of ['0.0.0.0', '::', '8.8.8.8', 'localhost', 'fd-server.example', undefined]) {
      await assert.rejects(() => server.listen({ host, port: 0 }), /explicit private LAN or loopback IP/);
    }
  } finally { await server.close(); db.close(); }
});

test('service rejects public binding before generating certificates and audits the failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wifi-private-bind-'));
  const service = createService({ dataDir: root, host: '0.0.0.0', resolveLibrary: () => null, listLibraries: () => [], indexPhoto: async () => {} });
  try {
    await assert.rejects(() => service.start(), /explicit private LAN or loopback IP/);
    assert.equal(service.status().running, false);
    assert.equal(service.repo.getSettings().enabled, false);
    assert.equal(service.db.prepare("SELECT result FROM activity_log WHERE kind='server_error'").get().result, 'failed');
    await assert.rejects(() => fs.access(path.join(root, 'server-cert.pem')), { code: 'ENOENT' });
  } finally { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('HTTPS works with a pinned self-signed certificate', async () => {
  const h = await harness({ tls: true });
  try {
    const status = h.service.status();
    assert.match(status.url, /^https:/);
    const pem = await fs.readFile(path.join(h.root, 'data', 'server-cert.pem'), 'utf8');
    const url = new URL(`${status.url}/api/v1/ping`);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: url.hostname, port: url.port, path: url.pathname, ca: pem, checkServerIdentity: () => undefined }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(JSON.parse(text)));
      }).on('error', reject);
    });
    assert.equal(body.tls, true);
    const unpinned = await new Promise(resolve => https.get({ host: url.hostname, port: url.port, path: url.pathname }, () => resolve('connected')).on('error', error => resolve(error.code)));
    assert.notEqual(unpinned, 'connected');
    assert.equal(new crypto.X509Certificate(pem).fingerprint256, status.fingerprint);
  } finally { await h.close(); }
});

test('phone folder structure is mirrored and delete is only approved for verified copies', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(2500, 8);
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'F1', filename: 'a.jpg', folderPath: 'DCIM/../Camera/Trips', mediaType: 'image/jpeg', size: data.length }]);
    const before = await h.api('POST', '/assets/verify-delete', { token, body: { assets: [{ assetId: asset.id, sha256: sha }] } });
    assert.equal(before.json.assets[0].safeToDelete, false);
    await h.upload(token, asset.id, data);
    const row = h.service.repo.getAsset(asset.id);
    assert.equal(row.library_path, 'Wi-Fi Sync/Test Phone/DCIM/Camera/Trips/a.jpg');
    const bad = await h.api('POST', '/assets/verify-delete', { token, body: { assets: [{ assetId: asset.id, sha256: 'f'.repeat(64) }] } });
    assert.equal(bad.json.assets[0].reason, 'hash_mismatch');
    assert.equal((await h.api('POST', `/assets/${asset.id}/deleted`, { token, body: { sha256: 'f'.repeat(64) } })).status, 409);
    const ok = await h.api('POST', '/assets/verify-delete', { token, body: { assets: [{ assetId: asset.id, sha256: sha }] } });
    assert.equal(ok.json.assets[0].safeToDelete, true);
    const storedFile = path.join(h.library.root, ...row.library_path.split('/'));
    const damaged = Buffer.from(data);
    damaged[100] ^= 0xff;
    await fs.writeFile(storedFile, damaged);
    const changed = await h.api('POST', '/assets/verify-delete', { token, body: { assets: [{ assetId: asset.id, sha256: sha }] } });
    assert.equal(changed.json.assets[0].safeToDelete, false);
    assert.equal(changed.json.assets[0].reason, 'missing_on_pc');
    await fs.writeFile(storedFile, data);
    await fs.rm(storedFile);
    const gone = await h.api('POST', '/assets/verify-delete', { token, body: { assets: [{ assetId: asset.id, sha256: sha }] } });
    assert.equal(gone.json.assets[0].reason, 'missing_on_pc');
  } finally { await h.close(); }
});

test('moveFolder rewrites paths, keeps metadata and rejects collisions', () => {
  let index = indexStore.create('r');
  index = indexStore.addPhoto(index, { path: 'a/x.jpg', size: 1, lastModified: 1 });
  index = indexStore.addPhoto(index, { path: 'a/sub/y.jpg', size: 1, lastModified: 1 });
  index = indexStore.addPhoto(index, { path: 'ab/z.jpg', size: 1, lastModified: 1 });
  index.entries[0].metadata.favorite = true;
  const { index: next, changed } = indexStore.moveFolder(index, 'a', 'b/c');
  assert.equal(changed, 2);
  assert.deepEqual(next.entries.map(entry => entry.path), ['b/c/x.jpg', 'b/c/sub/y.jpg', 'ab/z.jpg']);
  assert.equal(next.entries[0].metadata.favorite, true);
  assert.equal(next.entries[1].folder, 'b/c/sub');
  assert.throws(() => indexStore.moveFolder(index, 'a', 'a/inner'));
  assert.throws(() => indexStore.moveFolder(index, 'a', 'ab'.replace('ab', 'a/x.jpg/..')));
});

test('relocate updates recorded Wi-Fi library paths by whole folder prefix', async () => {
  const h = await harness();
  try {
    const token = await pairedDevice(h);
    const session = await h.session(token);
    const data = JPEG(1000, 2);
    const [{ asset }] = await h.register(token, session.id, [{ sourceAssetId: 'M', filename: 'm.jpg', mediaType: 'image/jpeg', size: data.length, folderPath: 'Cam' }]);
    await h.upload(token, asset.id, data);
    h.service.repo.relocate(h.library.id, 'Wi-Fi Sync/Test Phone/Cam', 'Wi-Fi Sync/Test Phone/Holiday');
    assert.equal(h.service.repo.getAsset(asset.id).library_path, 'Wi-Fi Sync/Test Phone/Holiday/m.jpg');
    h.service.repo.relocate(h.library.id, 'Wi-Fi Sync/Test Phone/Hol', 'X');
    assert.equal(h.service.repo.getAsset(asset.id).library_path, 'Wi-Fi Sync/Test Phone/Holiday/m.jpg');
  } finally { await h.close(); }
});

test('existing index behaviour is unchanged by addPhoto', () => {
  const index = indexStore.create('r');
  const next = indexStore.addPhoto(index, { path: 'a/b.jpg', size: 3, lastModified: 1 }, 'abc');
  assert.equal(next.entries.length, 1);
  assert.equal(indexStore.validate(next).ok, true);
  assert.equal(indexStore.addPhoto(next, { path: 'a/b.jpg', size: 4, lastModified: 2 }).entries.length, 1);
  assert.throws(() => indexStore.addPhoto(index, { path: '../x.jpg' }));
});
