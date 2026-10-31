'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('../index-store.js');
const { openSyncDb } = require('../electron/wifi-sync/db.cjs');
const { createRepo } = require('../electron/wifi-sync/repo.cjs');
const { openDb } = require('../server/db');
const { signJwt, verifyJwt } = require('../server/auth');
const { createBackup, processPendingRestore, captureMetadata, verifyBackup, safePath, writeJson, reconcileIndex, retireThumbnails } = require('../electron/backup.cjs');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mileo-backup-test-'));
  const userData = path.join(root, 'app');
  const media = path.join(root, 'photos');
  const destination = path.join(root, 'backups');
  for (const dir of [userData, media, destination]) await fs.mkdir(dir);
  const library = { id: 'a'.repeat(64), path: media, name: 'photos' };
  const libraries = [library];
  const data = Buffer.from('original photo bytes');
  await fs.writeFile(path.join(media, 'photo.jpg'), data);
  const stat = await fs.stat(path.join(media, 'photo.jpg'));
  const indexFile = path.join(userData, 'photo-library', 'indexes', `${library.id}.json`);
  let index = store.addPhoto(store.create(library.name), { path: 'photo.jpg', size: data.length, lastModified: Math.round(stat.mtimeMs) }, hash(data));
  index.entries[0].metadata.favorite = true;
  await writeJson(indexFile, index);
  await writeJson(path.join(userData, 'photo-library', 'libraries.json'), { format: 'still-photo-library-roots', version: 1, libraries });
  await writeJson(path.join(userData, 'branding.json'), { appName: 'Family photos' });
  const syncDb = openSyncDb(path.join(userData, 'wifi-sync', 'wifi-sync.db'));
  const accountDb = openDb(path.join(userData, 'account-server', 'still.db'));
  accountDb.prepare("INSERT INTO users (email, password_hash, display_name) VALUES ('family@example.test','hash','Family')").run();
  accountDb.prepare("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (1,'token-hash','2100-01-01')").run();
  const repo = createRepo(syncDb, { listAccounts: () => accountDb.prepare('SELECT id, email, role, disabled_at FROM users').all() });
  const { code } = repo.createPairingCode(120);
  const device = repo.claimPairingCode(code, 'Test phone', 'android');
  repo.setSettings({ enabled: true });
  const readIndex = async () => JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const scan = async () => ({
    files: (await fs.readdir(media)).filter(name => name.endsWith('.jpg')).map(name => ({ path: name, size: data.length, lastModified: Math.round(stat.mtimeMs) })),
    inaccessiblePaths: [], errors: []
  });
  const options = {
    userData, listLibraries: async () => libraries, readIndex,
    capture: async directory => {
      captureMetadata(userData, directory, { 'wifi-sync/wifi-sync.db': syncDb, 'account-server/still.db': accountDb });
      return { libraries, scans: { [library.id]: await scan() } };
    },
    rebuild: async () => {
      const current = await readIndex();
      const result = reconcileIndex(current, await scan());
      await writeJson(indexFile, result.index);
      await retireThumbnails(userData);
      return [{ status: 'reconciled', ...result.summary }];
    }
  };
  const service = createBackup(options);
  await service.configure(destination);
  let closed = false;
  const closeDbs = () => { if (!closed) { syncDb.close(); accountDb.close(); closed = true; } };
  t.after(async () => { closeDbs(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, userData, media, destination, library, data, indexFile, service, options, repo, device, syncDb, accountDb, closeDbs };
}
async function run(service, kind, options) {
  const { id } = await service.start(kind, options);
  for (let i = 0; i < 1000; i++) {
    const job = await service.detail(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Recovery job did not finish.');
}

test('verified snapshots include WAL data, JSON annotations, originals, and persistent history', async t => {
  const h = await harness(t);
  const job = await run(h.service, 'backup', { originals: true });
  assert.equal(job.state, 'completed', job.error);
  const manifest = await verifyBackup(job.location);
  assert.equal(job.processed, manifest.files.length);
  assert.ok(manifest.files.some(file => file.kind === 'original' && file.sha256 === hash(h.data)));
  assert.ok(!manifest.files.some(file => /(?:jwt-secret|saved-login|auth\.json|admin-credentials|incoming|thumbs)/.test(file.path)));
  const check = new DatabaseSync(path.join(job.location, 'metadata', 'account-server', 'still.db'), { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  check.close();
  const restarted = createBackup(h.options);
  const status = await restarted.status();
  assert.equal(status.jobs[0].id, job.id);
  assert.equal(status.settings.destination, h.destination);
  const verified = await run(restarted, 'verify', { backupId: job.id });
  assert.equal(verified.state, 'completed', verified.error);
});

test('metadata-only backup and opening an existing backup do not require originals', async t => {
  const h = await harness(t);
  await fs.rm(path.join(h.media, 'photo.jpg'));
  const job = await run(h.service, 'backup');
  assert.equal(job.state, 'completed', job.error);
  assert.equal((await verifyBackup(job.location)).files.some(file => file.kind === 'original'), false);
  const adopted = await run(h.service, 'adopt', { directory: job.location });
  assert.equal(adopted.state, 'completed', adopted.error);
  assert.equal(adopted.kind, 'backup');
  assert.equal(adopted.location, job.location);
  const rejected = await run(h.service, 'restore', { backupId: job.id, originals: true, confirm: true });
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.error, /metadata only/);
});

test('integrity reports corruption, missing files, un-hashed files and leaves originals and hashes unchanged', async t => {
  const h = await harness(t);
  const originalIndex = JSON.parse(await fs.readFile(h.indexFile, 'utf8'));
  const index = store.reconcile(originalIndex, [
    { path: 'photo.jpg', size: h.data.length, lastModified: originalIndex.entries[0].lastModified },
    { path: 'missing.jpg', size: 12, lastModified: 1 },
    { path: 'unknown.jpg', size: 4, lastModified: 1 }
  ]).index;
  await writeJson(h.indexFile, index);
  await fs.writeFile(path.join(h.media, 'photo.jpg'), Buffer.alloc(h.data.length, 88));
  await fs.writeFile(path.join(h.media, 'unknown.jpg'), 'test');
  const before = await fs.readFile(h.indexFile);
  const job = await run(h.service, 'integrity');
  assert.equal(job.state, 'completed', job.error);
  assert.equal(job.report.find(row => row.path === 'photo.jpg').status, 'mismatch');
  assert.equal(job.report.find(row => row.path === 'missing.jpg').status, 'missing');
  assert.equal(job.report.find(row => row.path === 'unknown.jpg').status, 'no_hash');
  assert.deepEqual(await fs.readFile(h.indexFile), before);
  assert.deepEqual(await fs.readFile(path.join(h.media, 'photo.jpg')), Buffer.alloc(h.data.length, 88));
});

test('integrity includes safely stored sync assets even if indexing never finished', async t => {
  const h = await harness(t);
  const service = createBackup({ ...h.options, syncAssets: () => [{ path: 'unindexed.jpg', size: 1, sha256: hash('x') }] });
  const job = await run(service, 'integrity');
  assert.equal(job.report.find(row => row.path === 'unindexed.jpg').status, 'missing');
});

test('backup of originals refuses missing or corrupt originals and never publishes partial copies', async t => {
  const h = await harness(t);
  await fs.writeFile(path.join(h.media, 'photo.jpg'), 'damaged');
  let job = await run(h.service, 'backup', { originals: true });
  assert.equal(job.state, 'failed');
  assert.match(job.error, /checksum mismatch/);
  assert.ok(job.location.endsWith('.partial'));
  await assert.rejects(fs.access(path.join(h.destination, `mileo-${job.id}`)));
  await fs.rm(path.join(h.media, 'photo.jpg'));
  job = await run(h.service, 'backup', { originals: true });
  assert.equal(job.state, 'failed');
  assert.match(job.error, /missing/);
});

test('tampered backups cannot be verified or staged for restore', async t => {
  const h = await harness(t);
  const job = await run(h.service, 'backup');
  assert.equal(job.state, 'completed', job.error);
  await fs.writeFile(path.join(job.location, 'metadata', 'branding.json'), '{}');
  await assert.rejects(verifyBackup(job.location), /checksum mismatch/);
  const restore = await run(h.service, 'restore', { backupId: job.id, confirm: true });
  assert.equal(restore.state, 'failed');
  await assert.rejects(fs.access(path.join(h.userData, 'recovery', 'restore.json')));
});

test('restore applies verified metadata on restart, restores only missing originals and revokes credentials', async t => {
  const h = await harness(t);
  h.accountDb.prepare("UPDATE users SET role='editor' WHERE id=1").run();
  const profileId = h.repo.family.saveProfile({ accountId: 1, name: 'Family', role: 'contributor', enabled: true });
  h.repo.family.saveDevice(h.device.id, { profileId, uploadEnabled: true, allowImages: true, allowVideos: false, maxFileSizeMB: 100 });
  h.repo.family.setGrant(profileId, h.library.id, 'family-album', true);
  assert.equal(h.repo.family.signIn(h.device.id, { id: 1, email: 'family@example.test' }), true);
  h.repo.setSettings({ familyEnabled: true });
  await fs.writeFile(path.join(h.media, 'second.jpg'), h.data);
  const backup = await run(h.service, 'backup', { originals: true });
  assert.equal(backup.state, 'completed', backup.error);
  await writeJson(path.join(h.userData, 'branding.json'), { appName: 'Changed since backup' });
  await fs.writeFile(path.join(h.userData, 'account-server', 'jwt-secret'), 'old signing secret');
  const oldAccessToken = signJwt({ sub: 1 }, 'old signing secret', 3600);
  await fs.writeFile(path.join(h.userData, 'saved-login.bin'), 'old saved password');
  await fs.rm(path.join(h.media, 'photo.jpg'));
  await fs.writeFile(path.join(h.media, 'second.jpg'), 'new original, must survive');
  const staged = await run(h.service, 'restore', { backupId: backup.id, originals: true, confirm: true });
  assert.equal(staged.state, 'awaiting_restart', staged.error);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.userData, 'branding.json'), 'utf8')).appName, 'Changed since backup');
  h.closeDbs();
  const result = await processPendingRestore(h.userData);
  assert.equal(result.restored, true, result.error);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.userData, 'branding.json'), 'utf8')).appName, 'Family photos');
  assert.deepEqual(await fs.readFile(path.join(h.media, 'photo.jpg')), h.data);
  assert.equal(await fs.readFile(path.join(h.media, 'second.jpg'), 'utf8'), 'new original, must survive');
  const sync = openSyncDb(path.join(h.userData, 'wifi-sync', 'wifi-sync.db'));
  const repo = createRepo(sync);
  assert.equal(repo.authenticate(h.device.token), null);
  assert.equal(repo.getSettings().enabled, false);
  assert.equal(repo.getSettings().familyEnabled, true);
  assert.equal(repo.family.profiles()[0].id, profileId);
  assert.equal(repo.family.grants()[0].album_id, 'family-album');
  assert.equal(sync.prepare('SELECT COUNT(*) AS n FROM family_logins').get().n, 0);
  assert.equal(sync.prepare('SELECT allow_videos FROM devices WHERE id=?').get(h.device.id).allow_videos, 0);
  sync.close();
  const accounts = openDb(path.join(h.userData, 'account-server', 'still.db'));
  assert.ok(accounts.prepare('SELECT revoked_at FROM refresh_tokens').get().revoked_at);
  accounts.close();
  assert.notEqual(await fs.readFile(path.join(h.userData, 'account-server', 'jwt-secret'), 'utf8'), 'old signing secret');
  assert.equal(verifyJwt(oldAccessToken, await fs.readFile(path.join(h.userData, 'account-server', 'jwt-secret'), 'utf8')), null);
  await assert.rejects(fs.access(path.join(h.userData, 'saved-login.bin')));
  const restored = await h.service.detail(staged.id);
  assert.equal(restored.state, 'completed');
  assert.ok(restored.report.some(row => row.status === 'conflict'));
  assert.equal(await fs.readFile(path.join(restored.rollback, 'saved-login.bin'), 'utf8'), 'old saved password');
  assert.equal((await h.service.status()).jobs.length, 2);
  assert.equal(await processPendingRestore(h.userData), null);
});

test('a verified M4 schema-4 backup restores and migrates without inventing family access', async t => {
  const h = await harness(t);
  h.syncDb.exec(`DROP TABLE family_logins; DROP TABLE album_grants;
    ALTER TABLE devices DROP COLUMN profile_id; ALTER TABLE devices DROP COLUMN upload_enabled;
    ALTER TABLE devices DROP COLUMN allow_images; ALTER TABLE devices DROP COLUMN allow_videos;
    ALTER TABLE devices DROP COLUMN max_file_size_mb; DROP TABLE family_profiles; PRAGMA user_version=4;`);
  const backup = await run(h.service, 'backup', { originals: false });
  assert.equal(backup.state, 'completed', backup.error);
  await verifyBackup(backup.location);
  const staged = await run(h.service, 'restore', { backupId: backup.id, confirm: true });
  assert.equal(staged.state, 'awaiting_restart', staged.error);
  h.closeDbs();
  assert.equal((await processPendingRestore(h.userData)).restored, true);
  const sync = openSyncDb(path.join(h.userData, 'wifi-sync', 'wifi-sync.db'));
  try {
    const repo = createRepo(sync);
    assert.equal(repo.getSettings().familyEnabled, false);
    assert.equal(repo.authenticate(h.device.token), null);
    assert.deepEqual(repo.family.profiles(), []);
  } finally { sync.close(); }
});

test('crash during metadata replacement rolls back before startup and preserves original media', async t => {
  const h = await harness(t);
  const backup = await run(h.service, 'backup');
  const staged = await run(h.service, 'restore', { backupId: backup.id, confirm: true });
  assert.equal(staged.state, 'awaiting_restart', staged.error);
  const journalFile = path.join(h.userData, 'recovery', 'restore.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  await fs.mkdir(journal.rollback);
  await fs.copyFile(path.join(h.userData, 'branding.json'), path.join(journal.rollback, 'branding.json'));
  journal.state = 'applying';
  journal.applied = [{ relative: 'branding.json', existed: true }];
  await writeJson(journalFile, journal);
  await fs.writeFile(path.join(h.userData, 'branding.json'), 'interrupted write');
  h.closeDbs();
  assert.equal((await processPendingRestore(h.userData)).rolledBack, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.userData, 'branding.json'), 'utf8')).appName, 'Family photos');
  assert.deepEqual(await fs.readFile(path.join(h.media, 'photo.jpg')), h.data);
  assert.equal((await h.service.detail(staged.id)).state, 'failed');
});

test('restart records interrupted jobs rather than treating partial backups as completed', async t => {
  const h = await harness(t);
  const id = crypto.randomUUID();
  await writeJson(path.join(h.userData, 'recovery', 'jobs', `${id}.json`), { id, kind: 'backup', state: 'running', startedAt: Date.now() });
  const restarted = createBackup(h.options);
  const job = (await restarted.status()).jobs.find(row => row.id === id);
  assert.equal(job.state, 'interrupted');
  assert.match(job.error, /Partial backups are not restore points/);
});

test('path traversal, nested destinations and linked paths are rejected', async t => {
  const h = await harness(t);
  await assert.rejects(h.service.configure(h.media), /overlap/);
  await assert.rejects(h.service.configure(h.userData), /overlap/);
  await assert.rejects(h.service.configure(h.root), /overlap/);
  await assert.rejects(safePath(h.media, '../outside.jpg'), /Unsafe/);
  await assert.rejects(safePath(h.media, 'folder\\escape.jpg'), /Unsafe/);
  const link = path.join(h.media, 'linked');
  await fs.symlink(h.destination, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safePath(h.media, 'linked/photo.jpg'), /Symbolic links/);
  const backup = await run(h.service, 'backup');
  const manifestFile = path.join(backup.location, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.files[0].relative = '../outside.json';
  await writeJson(manifestFile, manifest);
  await assert.rejects(verifyBackup(backup.location), /Unsafe/);
});

test('reconciliation preserves annotations, missing records and hash baselines; thumbnails can regenerate', async t => {
  const h = await harness(t);
  const previous = JSON.parse(await fs.readFile(h.indexFile, 'utf8'));
  const result = reconcileIndex(previous, {
    files: [{ path: 'photo.jpg', size: 999, lastModified: 999 }, { path: 'new.jpg', size: 1, lastModified: 1 }],
    inaccessiblePaths: []
  });
  assert.equal(result.index.entries[0].metadata.favorite, true);
  assert.equal(result.index.entries[0].contentHash, hash(h.data), 'do not silently accept changed content');
  const missing = reconcileIndex(previous, { files: [], inaccessiblePaths: [] });
  assert.equal(missing.index.entries.length, 1);
  assert.equal(missing.index.entries[0].missing, true);
  const protectedIndex = reconcileIndex(previous, { files: [], inaccessiblePaths: [''] });
  assert.equal(protectedIndex.index.entries[0].missing, false);
  const thumbs = path.join(h.userData, 'wifi-sync', 'thumbs');
  await fs.mkdir(thumbs);
  await fs.writeFile(path.join(thumbs, 'derived.jpg'), 'cached image');
  await assert.rejects(retireThumbnails(h.userData, [{ path: thumbs }]), /overlaps/);
  const retired = await retireThumbnails(h.userData);
  await assert.rejects(fs.access(thumbs));
  assert.equal(await fs.readFile(path.join(retired, 'derived.jpg'), 'utf8'), 'cached image');
  assert.deepEqual(await fs.readFile(path.join(h.media, 'photo.jpg')), h.data);
});

test('corrupt SQLite with a recomputed manifest hash is rejected by database verification', async t => {
  const h = await harness(t);
  const backup = await run(h.service, 'backup');
  assert.equal(backup.state, 'completed', backup.error);
  const manifestFile = path.join(backup.location, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const record = manifest.files.find(file => file.relative === 'wifi-sync/wifi-sync.db');
  const invalid = Buffer.from('not a SQLite database');
  await fs.writeFile(path.join(backup.location, ...record.path.split('/')), invalid);
  record.size = invalid.length;
  record.sha256 = hash(invalid);
  await writeJson(manifestFile, manifest);
  await assert.rejects(verifyBackup(backup.location), /database|SQLite/);
});

test('concurrent requests cannot start overlapping backup jobs', async t => {
  const h = await harness(t);
  const results = await Promise.allSettled([h.service.start('integrity'), h.service.start('integrity')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already|running/);
  while (h.service.busy()) await new Promise(resolve => setTimeout(resolve, 10));
});
