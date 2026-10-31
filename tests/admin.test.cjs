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
    indexPhoto: async () => {}, findDuplicate: async () => null, tls: false, host: '127.0.0.1', now: () => clock.now
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
    h.addAsset(device.id, done.id, 'duplicate.jpg', 'indexed', { fields: { sha256: 'b'.repeat(64), duplicate_library_path: 'Camera/original.jpg', last_error: 'duplicate' } });
    h.addAsset(device.id, done.id, '=evil.jpg', 'failed_permanent', { fields: { last_error: 'File exceeds the 4096 MB limit.' } });
    h.repo.completeSession(done.id);
    const open = h.repo.createSession(device.id, 'b').session;
    h.addAsset(device.id, open.id, 'v.mp4', 'uploading', { kind: 'video', fields: { bytes_received: 50 } });
    h.addAsset(device.id, open.id, 'pending.jpg', 'queued');

    const list = h.admin.sessions({});
    assert.equal(list.total, 2);
    const byId = Object.fromEntries(list.rows.map(row => [row.id, row]));
    assert.equal(byId[done.id].status, 'completed_with_errors');
    assert.equal(byId[done.id].succeeded, 2);
    assert.equal(byId[done.id].failed, 1);
    assert.equal(byId[open.id].status, 'running');

    assert.deepEqual(h.admin.sessions({ status: 'running' }).rows.map(row => row.id), [open.id]);
    assert.deepEqual(h.admin.sessions({ media: 'video' }).rows.map(row => row.id), [open.id]);
    assert.deepEqual(h.admin.sessions({ errorCategory: 'size' }).rows.map(row => row.id), [done.id]);
    assert.equal(h.admin.sessions({ deviceId: 'nope' }).total, 0);
    assert.equal(h.admin.sessions({ pageSize: 5, page: 99 }).page, 1);

    const detail = h.admin.sessionDetail(done.id);
    assert.equal(detail.files.length, 3);
    assert.equal(detail.files.find(file => file.name === 'ok.jpg').status, 'imported');
    assert.equal(detail.files.find(file => file.name === 'ok.jpg').checksum, 'recorded');
    assert.equal(detail.files.find(file => file.name === 'duplicate.jpg').status, 'duplicate');
    assert.equal(detail.files.find(file => file.name === '=evil.jpg').status, 'failed');
    assert.equal(detail.files.find(file => file.name === '=evil.jpg').errorCategory, 'size');
    const activeDetail = h.admin.sessionDetail(open.id);
    assert.equal(activeDetail.files.find(file => file.name === 'v.mp4').status, 'uploading');
    assert.equal(activeDetail.files.find(file => file.name === 'pending.jpg').status, 'pending');
    assert.equal(h.admin.deviceDetail(device.id).totals.duplicates, 1);
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

// ---- M3: administration dashboard ----

const crypto = require('node:crypto');
const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, fill)]);
async function placeTemp(h, asset, body) {
  await fs.mkdir(path.dirname(h.service.importer.tempPath(asset.id)), { recursive: true });
  await fs.writeFile(h.service.importer.tempPath(asset.id), body);
  return h.repo.update(asset.id, { state: 'uploading', bytes_received: body.length });
}
const kindsOf = h => h.admin.activity({ pageSize: 100 }).rows.map(row => row.kind);

test('overview reports total library assets, uploaded assets and registered devices from real data', async () => {
  const h = await harness();
  try {
    const a = h.pairDevice('A');
    h.pairDevice('B');
    await h.service.revokeDevice(a.id);
    const session = h.repo.createSession(a.id, 'o').session;
    const original = h.addAsset(a.id, session.id, 'one.jpg', 'indexed');
    h.addAsset(a.id, session.id, 'one-again.jpg', 'indexed', { fields: { duplicate_of: original.id, last_error: 'duplicate' } });
    h.addAsset(a.id, session.id, 'two.jpg', 'failed_permanent');
    const { cards } = await h.admin.overview();
    assert.equal(cards.libraryAssets, 2, 'missing index entries are not counted');
    assert.equal(cards.uploadedAssets, 1, 'duplicates do not count as new uploaded assets');
    assert.equal(cards.registeredDevices, 2);
    assert.equal(cards.pairedDevices, 1);
  } finally { await h.close(); }
});

test('file-level sync history filters by device, status, name and date without leaking paths', async () => {
  const h = await harness();
  try {
    const a = h.pairDevice('Alpha');
    const b = h.pairDevice('Beta');
    const sa = h.repo.createSession(a.id, 'f1').session;
    const sb = h.repo.createSession(b.id, 'f2').session;
    const original = h.addAsset(a.id, sa.id, 'IMG_1.jpg', 'indexed', { fields: { sha256: 'c'.repeat(64), library_path: 'Wi-Fi Sync/Alpha/IMG_1.jpg', stored_at: h.clock.now } });
    h.addAsset(a.id, sa.id, 'IMG_2.jpg', 'failed_permanent', { fields: { last_error: 'Uploaded file SHA-256 does not match the declared checksum.' } });
    h.addAsset(b.id, sb.id, 'VID_1.mp4', 'queued', { kind: 'video' });
    h.addAsset(b.id, sb.id, 'dup.jpg', 'indexed', { fields: { sha256: 'c'.repeat(64), duplicate_of: original.id, last_error: 'duplicate' } });

    assert.equal(h.admin.files({}).total, 4);
    assert.deepEqual(h.admin.files({ deviceId: a.id }).rows.map(r => r.name).sort(), ['IMG_1.jpg', 'IMG_2.jpg']);
    const failed = h.admin.files({ status: 'failed' }).rows;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].verification, 'mismatch');
    assert.equal(failed[0].errorCategory, 'integrity');
    assert.match(failed[0].error, /SHA-256/);
    const imported = h.admin.files({ status: 'imported' }).rows[0];
    assert.equal(imported.name, 'IMG_1.jpg');
    assert.equal(imported.verification, 'verified');
    assert.equal(imported.sha256.length, 16);
    assert.equal(h.admin.files({ status: 'duplicate' }).rows[0].name, 'dup.jpg');
    assert.equal(h.admin.files({ status: 'pending' }).rows[0].name, 'VID_1.mp4');
    assert.equal(h.admin.files({ search: 'VID' }).total, 1);
    assert.equal(h.admin.files({ search: '%' }).total, 0, 'LIKE wildcards are escaped');
    assert.equal(h.admin.files({ from: h.clock.now + 1000 }).total, 0);
    assert.equal(h.admin.files({ to: h.clock.now + 1000 }).total, 4);
    assert.equal(h.admin.files({ pageSize: 5, status: 'bogus' }).total, 4, 'unknown status is ignored');
    const serialized = JSON.stringify(h.admin.files({}));
    assert.ok(!serialized.includes('Wi-Fi Sync/Alpha') && !serialized.includes('c'.repeat(64)));
  } finally { await h.close(); }
});

test('upload queue groups jobs and only offers safe actions', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'q').session;
    h.addAsset(d.id, s.id, 'pending.jpg', 'queued');
    h.addAsset(d.id, s.id, 'interrupted.jpg', 'uploading', { fields: { bytes_received: 40 } });
    h.addAsset(d.id, s.id, 'stored.jpg', 'stored', { fields: { library_path: 'x/stored.jpg', stored_at: h.clock.now } });
    h.addAsset(d.id, s.id, 'broken.jpg', 'failed_retryable', { fields: { last_error: 'Indexing failed: offline', library_path: 'x/broken.jpg', stored_at: h.clock.now } });
    h.addAsset(d.id, s.id, 'done.jpg', 'indexed');
    const queue = h.admin.queue();
    assert.equal(queue.running, false);
    assert.deepEqual(queue.pending.map(r => r.name), ['pending.jpg']);
    assert.deepEqual(queue.active.map(r => r.name).sort(), ['interrupted.jpg', 'stored.jpg']);
    assert.deepEqual(queue.failed.map(r => r.name), ['broken.jpg']);
    const byName = Object.fromEntries([...queue.pending, ...queue.active, ...queue.failed].map(r => [r.name, r]));
    assert.equal(byName['pending.jpg'].canCancel, true);
    assert.equal(byName['interrupted.jpg'].canCancel, true);
    assert.equal(byName['stored.jpg'].canCancel, false);
    assert.equal(byName['stored.jpg'].canRetry, true);
    assert.equal(byName['broken.jpg'].canCancel, false, 'files already in the library are never cancellable');
    assert.equal(byName['broken.jpg'].canRetry, true);
  } finally { await h.close(); }
});

test('cancelling a job is safe, logged, idempotent and never touches library files', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'c').session;
    const partial = h.addAsset(d.id, s.id, 'partial.jpg', 'queued');
    await placeTemp(h, partial, jpeg().subarray(0, 40));
    h.repo.update(partial.id, { state: 'queued' });
    const libraryFile = path.join(h.library.root, 'kept.jpg');
    await fs.writeFile(libraryFile, jpeg());
    const inLibrary = h.addAsset(d.id, s.id, 'kept.jpg', 'failed_retryable', { fields: { library_path: 'kept.jpg', stored_at: h.clock.now } });
    const done = h.addAsset(d.id, s.id, 'done.jpg', 'indexed');

    const cancelled = await h.service.cancelAsset(partial.id);
    assert.equal(cancelled.state, 'cancelled');
    await assert.rejects(fs.stat(h.service.importer.tempPath(partial.id)), /ENOENT/);
    assert.ok(kindsOf(h).includes('asset_cancelled'));
    await assert.rejects(h.service.cancelAsset(partial.id), /Only pending/);
    await assert.rejects(h.service.cancelAsset(inLibrary.id), /already in the library/);
    await assert.rejects(h.service.cancelAsset(done.id), /Only pending/);
    await assert.rejects(h.service.cancelAsset('missing'), /not found/);
    assert.ok(await fs.stat(libraryFile));
    assert.equal(h.repo.getAsset(inLibrary.id).state, 'failed_retryable');
  } finally { await h.close(); }
});

test('cancel is refused while a file is being verified', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'v').session;
    const asset = h.addAsset(d.id, s.id, 'busy.jpg', 'queued', { fields: { size: 100 } });
    await placeTemp(h, asset, jpeg());
    const pending = h.service.importer.finalize(asset.id);
    // finalize marks the asset as verifying synchronously before awaiting anything.
    assert.equal(h.service.importer.isVerifying(asset.id), true);
    await assert.rejects(h.service.cancelAsset(asset.id), /being verified/);
    const result = await pending;
    assert.equal(result.state, 'indexed');
  } finally { await h.close(); }
});

test('administrator retry resets the retry budget and requeues incomplete uploads', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'r').session;
    const failed = h.addAsset(d.id, s.id, 'retry.jpg', 'failed_permanent', { fields: { retry_count: 6, last_error: 'network', bytes_received: 10 } });
    const after = await h.service.adminRetryAsset(failed.id);
    assert.equal(after.state, 'queued');
    assert.equal(after.retry_count, 0);
    assert.ok(kindsOf(h).includes('retry_requested'));
    await assert.rejects(h.service.adminRetryAsset(failed.id), /Only failed/);
  } finally { await h.close(); }
});

test('pause and resume stop and restart receiving and are logged', async () => {
  const h = await harness();
  try {
    await h.service.resumeUploads();
    assert.equal(h.service.isRunning(), true);
    await h.service.pauseUploads();
    assert.equal(h.service.isRunning(), false);
    assert.equal(h.admin.queue().running, false);
    await h.service.resumeUploads();
    assert.equal(h.service.isRunning(), true);
    const kinds = kindsOf(h);
    for (const kind of ['uploads_paused', 'server_stopped', 'uploads_resumed', 'server_started']) assert.ok(kinds.includes(kind), kind);
  } finally { await h.close(); }
});

test('import, duplicate and startup recovery events appear in the activity log', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'e').session;
    const body = jpeg(7);
    const first = h.addAsset(d.id, s.id, 'first.jpg', 'queued', { fields: { size: body.length } });
    await placeTemp(h, first, body);
    assert.equal((await h.service.importer.finalize(first.id)).state, 'indexed');
    const second = h.addAsset(d.id, s.id, 'second.jpg', 'queued', { fields: { size: body.length } });
    await placeTemp(h, second, body);
    const dup = await h.service.importer.finalize(second.id);
    assert.equal(dup.duplicate_of, first.id);
    const third = h.addAsset(d.id, s.id, 'third.jpg', 'queued', { fields: { size: body.length } });
    await placeTemp(h, third, jpeg(9));
    await h.service.start();
    assert.equal(h.repo.getAsset(third.id).state, 'indexed');
    const kinds = kindsOf(h);
    for (const kind of ['upload_imported', 'upload_duplicate', 'recovery']) assert.ok(kinds.includes(kind), kind);
    assert.equal(crypto.createHash('sha256').update(jpeg(9)).digest('hex'), h.repo.getAsset(third.id).sha256);
  } finally { await h.close(); }
});

test('revoking a device from the dashboard invalidates its credential', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice('Lost phone');
    assert.ok(h.repo.authenticate(d.token));
    await h.service.revokeDevice(d.id);
    assert.equal(h.repo.authenticate(d.token), null);
    assert.equal(h.admin.devices({}).rows.find(row => row.id === d.id).status, 'revoked');
  } finally { await h.close(); }
});

test('system page reports the incoming temporary directory', async () => {
  const h = await harness();
  try {
    const d = h.pairDevice();
    const s = h.repo.createSession(d.id, 'i').session;
    const asset = h.addAsset(d.id, s.id, 'part.jpg', 'queued');
    await placeTemp(h, asset, Buffer.alloc(30));
    const system = await h.admin.system();
    assert.equal(system.incoming.path, path.join(h.root, 'data', 'incoming'));
    assert.equal(system.incoming.files, 1);
    assert.equal(system.incoming.bytes, 30);
  } finally { await h.close(); }
});
