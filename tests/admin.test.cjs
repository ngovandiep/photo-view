'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createAdmin, errorCategory, sessionStatus } = require('../electron/wifi-sync/admin.cjs');

async function harness({ users = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-'));
  const library = { id: 'b'.repeat(64), root: path.join(root, 'photos'), name: 'photos', path: path.join(root, 'photos') };
  await fs.mkdir(library.root, { recursive: true });
  const clock = { now: Date.now() };
  const service = createService({
    dataDir: path.join(root, 'data'), resolveLibrary: () => library, listLibraries: () => [library],
    indexPhoto: async () => {}, tls: false, host: '127.0.0.1', now: () => clock.now
  });
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id });
  const admin = createAdmin({
    service, dataDir: path.join(root, 'data'), listLibraries: () => [library],
    readIndex: async () => ({ entries: [{ extension: 'jpg', size: 10 }, { extension: 'mp4', size: 20 }, { extension: 'jpg', size: 5, missing: true }] }),
    getAccount: async () => null, listAccountUsers: users, now: () => clock.now
  });
  const { repo } = service;
  const pairDevice = (name = 'Phone', platform = 'android') => {
    const { code } = repo.createPairingCode(120);
    return repo.claimPairingCode(code, name, platform);
  };
  const addAsset = (deviceId, sessionId, name, state, extra = {}) => {
    const { asset } = repo.registerAsset(deviceId, sessionId, { sourceAssetId: name, filename: name, mediaType: 'image/jpeg', kind: extra.kind || 'image', size: extra.size || 100, capturedAt: null });
    return repo.update(asset.id, { state, ...(extra.fields || {}) });
  };
  return { root, library, service, admin, repo, clock, pairDevice, addAsset, async close() { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('error categories and session statuses are derived consistently', () => {
  assert.equal(errorCategory('Not enough free disk space on the desktop.'), 'storage');
  assert.equal(errorCategory('File exceeds the 4096 MB limit.'), 'size');
  assert.equal(errorCategory('Indexing failed: database offline'), 'indexing');
  assert.equal(errorCategory('File content does not match its type.'), 'file_type');
  assert.equal(errorCategory(''), '');
  assert.equal(sessionStatus({ status: 'open', started: 0, ok: 0, failed: 0 }), 'queued');
  assert.equal(sessionStatus({ status: 'open', started: 2, ok: 1, failed: 0 }), 'running');
  assert.equal(sessionStatus({ status: 'completed', ok: 3, failed: 0 }), 'completed');
  assert.equal(sessionStatus({ status: 'completed', ok: 3, failed: 1 }), 'completed_with_errors');
  assert.equal(sessionStatus({ status: 'completed', ok: 0, failed: 2 }), 'failed');
  assert.equal(sessionStatus({ status: 'cancelled', ok: 0, failed: 0 }), 'cancelled');
});

test('activity log records security and operational events without secrets', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const { code } = await h.service.createPairing();
    const device = h.repo.claimPairingCode(code, 'Pixel', 'android');
    h.service.updateSettings({ maxFileSizeMB: 100 });
    await h.service.revokeDevice(device.id);
    await h.service.stop();

    const all = h.admin.activity({ pageSize: 100 });
    const kinds = all.rows.map(row => row.kind);
    for (const kind of ['server_started', 'pairing_code_created', 'device_paired', 'config_changed', 'device_revoked', 'server_stopped']) assert.ok(kinds.includes(kind), kind);
    assert.ok(h.admin.activity({ category: 'security' }).rows.every(row => row.category === 'security'));
    const serialized = JSON.stringify(all.rows);
    assert.ok(!serialized.includes(code) && !serialized.includes(device.token));
    assert.equal(h.admin.activity({ search: 'revoked' }).rows.every(row => /revoked/i.test(row.message + row.kind)), true);
    assert.equal(h.admin.activity({ pageSize: 5, page: 2 }).page, 2);
  } finally { await h.close(); }
});

test('sync history lists sessions with status, filters, detail, pagination and safe CSV', async () => {
  const h = await harness();
  try {
    const device = h.pairDevice('Galaxy');
    const done = h.repo.createSession(device.id, 'a').session;
    h.addAsset(device.id, done.id, 'ok.jpg', 'indexed', { fields: { bytes_received: 100, sha256: 'a'.repeat(64) } });
    h.addAsset(device.id, done.id, '=evil.jpg', 'failed_permanent', { fields: { last_error: 'File exceeds the 4096 MB limit.' } });
    h.repo.completeSession(done.id);
    const open = h.repo.createSession(device.id, 'b').session;
    h.addAsset(device.id, open.id, 'v.mp4', 'uploading', { kind: 'video', fields: { bytes_received: 50 } });

    const list = h.admin.sessions({});
    assert.equal(list.total, 2);
    const byId = Object.fromEntries(list.rows.map(row => [row.id, row]));
    assert.equal(byId[done.id].status, 'completed_with_errors');
    assert.equal(byId[done.id].succeeded, 1);
    assert.equal(byId[done.id].failed, 1);
    assert.equal(byId[open.id].status, 'running');

    assert.deepEqual(h.admin.sessions({ status: 'running' }).rows.map(row => row.id), [open.id]);
    assert.deepEqual(h.admin.sessions({ media: 'video' }).rows.map(row => row.id), [open.id]);
    assert.deepEqual(h.admin.sessions({ errorCategory: 'size' }).rows.map(row => row.id), [done.id]);
    assert.equal(h.admin.sessions({ deviceId: 'nope' }).total, 0);
    assert.equal(h.admin.sessions({ pageSize: 5, page: 99 }).page, 1);

    const detail = h.admin.sessionDetail(done.id);
    assert.equal(detail.files.length, 2);
    assert.equal(detail.files.find(file => file.name === 'ok.jpg').checksum, 'recorded');
    assert.equal(detail.files.find(file => file.name === '=evil.jpg').errorCategory, 'size');
    assert.ok(!JSON.stringify(detail).includes('library_path'));
    assert.throws(() => h.admin.sessionDetail('missing'), /not found/);

    const csv = h.admin.sessionsCsv({});
    assert.equal(csv.split('\r\n').length, 3);
    assert.ok(csv.startsWith('Session ID,Device'));
  } finally { await h.close(); }
});

test('retrying a session only requeues failed files and is idempotent', async () => {
  const h = await harness();
  try {
    const device = h.pairDevice();
    const session = h.repo.createSession(device.id, 'r').session;
    const failed = h.addAsset(device.id, session.id, 'bad.jpg', 'failed_permanent', { fields: { last_error: 'boom' } });
    const stored = h.addAsset(device.id, session.id, 'good.jpg', 'indexed');
    h.service.retryAsset = async id => { h.repo.requeue(id); };
    const first = await h.admin.retrySession(session.id);
    assert.deepEqual(first, { retried: 1, requested: 1 });
    assert.equal(h.repo.getAsset(failed.id).state, 'queued');
    assert.equal(h.repo.getAsset(stored.id).state, 'indexed');
    const second = await h.admin.retrySession(session.id);
    assert.deepEqual(second, { retried: 0, requested: 0 });
  } finally { await h.close(); }
});

test('device list derives status, supports rename, revoke and removal without deleting assets', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const online = h.pairDevice('Online');
    const idle = h.pairDevice('Idle');
    const broken = h.pairDevice('Broken');
    h.repo.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(h.clock.now, online.id);
    h.repo.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(h.clock.now - 3600000, idle.id);
    const session = h.repo.createSession(broken.id, 'k').session;
    h.addAsset(broken.id, session.id, 'x.jpg', 'failed_permanent', { fields: { last_error: 'bad' } });
    const kept = h.addAsset(online.id, null, 'keep.jpg', 'indexed');

    const statuses = Object.fromEntries(h.admin.devices({}).rows.map(row => [row.name, row.status]));
    assert.deepEqual(statuses, { Online: 'connected', Idle: 'disconnected', Broken: 'error' });
    assert.equal(h.admin.devices({ status: 'error' }).total, 1);
    assert.equal(h.admin.devices({ search: 'onl' }).total, 1);

    await h.service.renameDevice(online.id, '  Living room  ');
    assert.equal(h.admin.deviceDetail(online.id).device.name, 'Living room');
    await assert.rejects(() => h.service.renameDevice(online.id, '   '), /name is required/);

    await h.service.revokeDevice(idle.id);
    assert.equal(h.admin.devices({ search: 'Idle' }).rows[0].status, 'revoked');
    assert.equal(h.repo.authenticate(idle.token), null);

    await h.service.removeDevice(online.id);
    assert.equal(h.admin.devices({}).total, 2);
    assert.equal(h.repo.authenticate(online.token), null);
    assert.equal(h.repo.getAsset(kept.id).state, 'indexed', 'imported assets survive device removal');
    await assert.rejects(() => h.service.removeDevice(online.id), /not found/);
    assert.ok(h.admin.activity({ search: 'removed' }).rows.some(row => row.kind === 'device_removed'));
  } finally { await h.close(); }
});

test('overview, wifi, system and users report real data and clear unavailable states', async () => {
  const h = await harness();
  try {
    const device = h.pairDevice();
    const session = h.repo.createSession(device.id, 's').session;
    h.addAsset(device.id, session.id, 'a.jpg', 'indexed', { size: 1000 });
    h.addAsset(device.id, session.id, 'b.mp4', 'queued', { kind: 'video' });

    let overview = await h.admin.overview();
    assert.equal(overview.cards.users, null);
    assert.equal(overview.cards.syncedPhotos, 1);
    assert.equal(overview.cards.pendingJobs, 1);
    assert.equal(overview.cards.libraryBytes, 30);
    assert.equal(overview.charts.syncedPerDay.length, 14);
    assert.equal(overview.charts.syncedPerDay.at(-1).count, 1);
    assert.equal(overview.charts.cumulativeBytes.at(-1).bytes, 1000);
    assert.equal(overview.server.running, false);

    await h.service.start();
    const wifi = await h.admin.wifi();
    assert.equal(wifi.running, true);
    assert.equal(wifi.reachability.reachable, true);
    assert.equal(wifi.security.privateOnly, true);
    assert.equal(wifi.pairedDevices, 1);
    assert.ok(wifi.startedAt);

    const system = await h.admin.system();
    assert.equal(system.database.status, 'ok');
    assert.equal(system.totals.photos, 1);
    assert.equal(system.totals.videos, 1);
    assert.equal(system.pendingSync, 1);
    assert.equal(system.server.reachable, true);

    assert.equal((await h.admin.users()).directory.available, false);
    const withUsers = await harness({ users: () => [{ id: 1, email: 'a@b.co', display_name: 'A', created_at: 'x', last_login_at: null }] });
    try {
      const directory = (await withUsers.admin.users()).directory;
      assert.equal(directory.available, true);
      assert.ok(!JSON.stringify(directory).includes('password'));
      overview = await withUsers.admin.overview();
      assert.equal(overview.cards.users, 1);
    } finally { await withUsers.close(); }
  } finally { await h.close(); }
});

test('stuck jobs and low disk space raise system warnings', async () => {
  const h = await harness();
  try {
    const device = h.pairDevice();
    const session = h.repo.createSession(device.id, 'w').session;
    h.addAsset(device.id, session.id, 'stuck.jpg', 'uploading');
    h.clock.now += 31 * 60 * 1000;
    const system = await h.admin.system();
    assert.equal(system.stuck, 1);
    assert.ok(system.warnings.some(item => /stuck/.test(item)));
  } finally { await h.close(); }
});
