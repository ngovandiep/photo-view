'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const indexStore = require('../index-store.js');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createRepo } = require('../electron/wifi-sync/repo.cjs');
const { openSyncDb } = require('../electron/wifi-sync/db.cjs');
const { createSyncServer } = require('../electron/wifi-sync/server.cjs');
const { createImporter, sanitizeFileName } = require('../electron/wifi-sync/importer.cjs');
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
  const service = createService({
    dataDir: path.join(root, 'data'),
    resolveLibrary: id => (!id || id === library.id ? library : null),
    listLibraries: () => [library],
    indexPhoto: async (_id, photo, hash) => {
      if (state.failIndex) throw new Error('index database offline');
      index = indexStore.addPhoto(index, photo, hash);
    },
    tls: options.tls === true,
    host: '127.0.0.1',
    now: () => state.clock
  });
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id, minFreeSpaceMB: 0, ...(options.settings || {}) });
  await service.start();
  const base = service.status().url;
  const api = async (method, route, { token, body, headers = {}, raw } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
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
  return {
    root, library, service, api, pair, session, register, upload, state,
    index: () => index,
    async close() { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); }
  };
}

async function pairedDevice(h) {
  const paired = await h.pair();
  assert.equal(paired.status, 201);
  return paired.json.token;
}

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
    const row = h.service.repo.getAsset(asset.id);
    assert.equal(row.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.match(row.library_path, /^Wi-Fi Sync\/Test Phone\/2024\/05\/IMG_1\.jpg$/);
    assert.deepEqual(await fs.readFile(path.join(h.library.root, ...row.library_path.split('/'))), data);
    assert.ok(h.index().entries.some(entry => entry.path === row.library_path && entry.contentHash === row.sha256));
    const leftovers = (await fs.readdir(path.join(h.root, 'data', 'incoming'))).filter(name => name.endsWith('.part'));
    assert.equal(leftovers.length, 0);
  } finally { await h.close(); }
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
    h.service.repo.update(asset.id, { state: 'stored' });
    await h.service.importer.recover();
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
  assert.equal(first.prepare('PRAGMA user_version').get().user_version, 2);
  first.close();
  const second = openSyncDb(file);
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, 2);
  second.close();
});

test('private-network check rejects public addresses', () => {
  assert.ok(security.isPrivateAddress('192.168.1.20'));
  assert.ok(security.isPrivateAddress('::ffff:10.0.0.5'));
  assert.ok(!security.isPrivateAddress('8.8.8.8'));
  assert.ok(!security.isPrivateAddress('172.32.0.1'));
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
    await fs.rm(path.join(h.library.root, ...row.library_path.split('/')));
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
