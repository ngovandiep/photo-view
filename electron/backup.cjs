'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { sha256File } = require('./wifi-sync/importer.cjs');
const indexStore = require('../index-store.js');
const { MIGRATION_COUNT } = require('./wifi-sync/db.cjs');

const FORMAT = 'mileo-backup';
const ID = /^[a-f0-9-]{36}$/;
const LIBRARY_ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIXED_FILES = new Set(['photo-library/libraries.json', 'branding.json', 'wifi-sync/wifi-sync.db', 'account-server/still.db']);

function inside(parent, file) {
  const relative = path.relative(parent, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('Unsafe backup relative path.');
  }
  return value;
}

function metadataFile(value) {
  relativeFile(value);
  if (!FIXED_FILES.has(value) && !/^photo-library\/indexes\/[a-f0-9]{64}\.json$/.test(value) && !/^session\/users\/[a-z0-9_-]{1,40}\/ui\.json$/i.test(value)) {
    throw new Error(`Unsupported metadata file: ${value}`);
  }
  return value;
}

async function optionalStat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Reject links at every existing path component, including Windows junctions.
async function safePath(root, relative) {
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Storage roots must not be symbolic links.');
  const base = await fs.realpath(root);
  let current = base;
  for (const part of relativeFile(relative).split('/')) {
    current = path.join(current, part);
    const stat = await optionalStat(current);
    if (stat && stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative}`);
  }
  if (!inside(base, current)) throw new Error('Path escapes its storage root.');
  return current;
}

const fileQueues = new Map();
function fileAccess(file, work) {
  const pending = (fileQueues.get(file) || Promise.resolve()).catch(() => {}).then(work);
  fileQueues.set(file, pending);
  const clear = () => { if (fileQueues.get(file) === pending) fileQueues.delete(file); };
  pending.then(clear, clear);
  return pending;
}

function writeJson(file, value) { return fileAccess(file, () => writeJsonOnce(file, value)); }
async function writeJsonOnce(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  try { await replace(temp, file); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

async function replace(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function readJson(file) { return fileAccess(file, async () => JSON.parse(await fs.readFile(file, 'utf8'))); }

function checkDatabase(file, kind) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) throw new Error(`SQLite integrity check failed: ${kind}`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`SQLite foreign key check failed: ${kind}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const required = kind === 'sync' ? ['assets', 'settings', 'devices', 'pairing_codes'] : ['users', 'refresh_tokens', 'annotations'];
    if (required.some(name => !tables.has(name))) throw new Error(`Invalid ${kind} database schema.`);
    if (kind === 'sync') {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version < 4 || version > MIGRATION_COUNT) throw new Error('Sync backup schema is not supported by this app version.');
      if (version >= 5 && ['family_profiles', 'album_grants', 'family_logins'].some(name => !tables.has(name))) throw new Error('Invalid family database schema.');
    }
  } finally { db.close(); }
}

function reconcileIndex(previous, scan) {
  const result = indexStore.reconcile(previous, scan.files, scan.inaccessiblePaths);
  const hashes = new Map(previous.entries.filter(entry => entry.contentHash).map(entry => [entry.path, entry.contentHash]));
  for (const entry of result.index.entries) if (hashes.has(entry.path)) entry.contentHash = hashes.get(entry.path);
  return result;
}

async function retireThumbnails(userData, libraries = []) {
  const source = path.join(userData, 'wifi-sync', 'thumbs');
  if (!await optionalStat(source)) return null;
  const realSource = await fs.realpath(source);
  for (const library of libraries) {
    let root;
    try { root = await fs.realpath(library.path); } catch (error) { if (error.code !== 'ENOENT') throw error; root = path.resolve(library.path); }
    if (root === realSource || inside(root, realSource) || inside(realSource, root)) throw new Error('Thumbnail cache overlaps a registered original library and cannot be retired.');
  }
  const target = path.join(userData, 'recovery', `retired-thumbnails-${crypto.randomUUID()}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.rename(source, target); return target; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Called synchronously while application metadata writers are held at a maintenance gate.
function captureMetadata(userData, destination, databases = {}) {
  syncFs.mkdirSync(destination, { recursive: true });
  const copy = relative => {
    metadataFile(relative);
    const source = path.join(userData, ...relative.split('/'));
    if (!syncFs.existsSync(source)) return;
    let current = userData;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (!syncFs.existsSync(current)) return;
      if (syncFs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked metadata is not supported: ${relative}`);
    }
    const target = path.join(destination, ...relative.split('/'));
    syncFs.mkdirSync(path.dirname(target), { recursive: true });
    syncFs.copyFileSync(source, target, syncFs.constants.COPYFILE_EXCL);
  };
  for (const file of ['photo-library/libraries.json', 'branding.json']) copy(file);
  const indexes = path.join(userData, 'photo-library', 'indexes');
  if (syncFs.existsSync(indexes)) {
    if (syncFs.lstatSync(indexes).isSymbolicLink()) throw new Error('Linked index directory is not supported.');
    for (const name of syncFs.readdirSync(indexes)) if (/^[a-f0-9]{64}\.json$/.test(name)) copy(`photo-library/indexes/${name}`);
  }
  const sessions = path.join(userData, 'session', 'users');
  if (syncFs.existsSync(sessions)) {
    if (syncFs.lstatSync(sessions).isSymbolicLink()) throw new Error('Linked session directory is not supported.');
    for (const name of syncFs.readdirSync(sessions)) if (/^[a-z0-9_-]{1,40}$/i.test(name)) copy(`session/users/${name}/ui.json`);
  }
  for (const [relative, db] of Object.entries(databases)) {
    metadataFile(relative);
    if (!db) throw new Error(`Database is unavailable for backup: ${relative}`);
    const target = path.join(destination, ...relative.split('/'));
    syncFs.mkdirSync(path.dirname(target), { recursive: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }
}

async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Linked backup content: ${name}`);
    if (entry.isDirectory()) result.push(...await inventory(path.join(directory, entry.name), name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported backup content: ${name}`);
  }
  return result;
}

async function verifyBackup(directory) {
  const manifest = await readJson(await safePath(directory, 'manifest.json'));
  if (manifest.format !== FORMAT || manifest.version !== 1 || !ID.test(manifest.id) || !Array.isArray(manifest.files) || !Array.isArray(manifest.libraries)) throw new Error('Unsupported or incomplete backup manifest.');
  if (manifest.files.length > 2000000) throw new Error('Backup exceeds the supported file limit.');
  const libraries = new Map();
  for (const library of manifest.libraries) {
    if (!LIBRARY_ID.test(library.id) || typeof library.path !== 'string' || !path.isAbsolute(library.path) || libraries.has(library.id)) throw new Error('Invalid backup library identity.');
    libraries.set(library.id, library);
  }
  const seen = new Set();
  for (const file of manifest.files) {
    relativeFile(file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !HASH.test(file.sha256)) throw new Error('Invalid or duplicate backup file record.');
    seen.add(file.path);
    if (file.kind === 'metadata') {
      if (file.path !== `metadata/${metadataFile(file.relative)}`) throw new Error('Metadata destination does not match its backup path.');
    } else if (file.kind === 'original') {
      if (!libraries.has(file.libraryId) || file.path !== `originals/${file.libraryId}/${relativeFile(file.relative)}`) throw new Error('Invalid original media reference.');
    } else throw new Error('Unknown backup file kind.');
    const source = await safePath(directory, file.path);
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size !== file.size || await sha256File(source) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
    if (file.kind === 'metadata' && file.relative.endsWith('.db')) checkDatabase(source, file.relative.startsWith('wifi-sync/') ? 'sync' : 'account');
    if (file.kind === 'metadata' && file.relative.startsWith('photo-library/indexes/')) {
      const validated = indexStore.validate(await readJson(source));
      if (!validated.ok) throw new Error(`Invalid backed-up index: ${validated.error}`);
    }
  }
  if (!seen.has('metadata/photo-library/libraries.json') || !seen.has('metadata/wifi-sync/wifi-sync.db') || !seen.has('metadata/account-server/still.db')) throw new Error('Backup is missing required library, sync or account metadata.');
  const roots = await readJson(await safePath(directory, 'metadata/photo-library/libraries.json'));
  if (roots.format !== 'still-photo-library-roots' || roots.version !== 1 || !Array.isArray(roots.libraries) || roots.libraries.length !== libraries.size) throw new Error('Invalid backed-up library manifest.');
  for (const root of roots.libraries) {
    if (!libraries.has(root.id) || root.path !== libraries.get(root.id).path || root.name !== libraries.get(root.id).name) throw new Error('Backup library manifests disagree.');
    if (!seen.has(`metadata/photo-library/indexes/${root.id}.json`)) throw new Error(`Backup lacks an index for ${root.name}.`);
  }
  return manifest;
}

async function copyVerified(source, target, expectedHash) {
  const before = await fs.stat(source);
  if (!before.isFile()) throw new Error('Backup source is not a regular file.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, syncFs.constants.COPYFILE_EXCL);
  const after = await fs.stat(source);
  const hash = await sha256File(target);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (expectedHash && hash !== expectedHash) || hash !== await sha256File(source)) throw new Error(`Source changed or has a checksum mismatch: ${source}`);
  return { size: before.size, sha256: hash };
}

function createBackup({ userData, listLibraries, readIndex, capture, rebuild, syncAssets = () => [], emit = error => { if (error instanceof Error) console.error('Recovery job persistence failed:', error); } }) {
  const stateDir = path.join(userData, 'recovery');
  const jobsDir = path.join(stateDir, 'jobs');
  const settingsFile = path.join(stateDir, 'settings.json');
  let active = null;
  let ready;
  const init = () => ready || (ready = (async () => {
    await fs.mkdir(jobsDir, { recursive: true });
    for (const name of await fs.readdir(jobsDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const job = await readJson(path.join(jobsDir, name));
      if (job.state === 'running') {
        Object.assign(job, { state: 'interrupted', finishedAt: Date.now(), error: 'Application stopped before this job completed. Partial backups are not restore points; run the job again.' });
        await writeJson(path.join(jobsDir, name), job);
      }
    }
  })());
  const save = async job => { await writeJson(path.join(jobsDir, `${job.id}.json`), job); emit(); };
  const settings = async () => {
    try { const value = await readJson(settingsFile); if (value.version !== 1) throw new Error('Unsupported backup settings version.'); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, destination: '' }; throw error; }
  };
  async function checkDestination(destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Select an absolute backup destination.');
    const resolved = await fs.realpath(destination);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Backup destination must be a directory.');
    for (const root of [userData, ...(await listLibraries()).map(library => library.path)]) {
      let real;
      try { real = await fs.realpath(root); } catch (error) { if (error.code !== 'ENOENT') throw error; real = path.resolve(root); }
      if (real === resolved || inside(real, resolved) || inside(resolved, real)) throw new Error('Backup destination must not overlap application data or any original library.');
    }
    return resolved;
  }
  async function configure(destination) {
    await init();
    if (active) throw new Error('Wait for the current recovery job to finish.');
    const value = { version: 1, destination: await checkDestination(destination) };
    await writeJson(settingsFile, value);
    return value;
  }
  async function status() {
    await init();
    const jobs = [];
    for (const name of await fs.readdir(jobsDir)) if (/^[a-f0-9-]{36}\.json$/.test(name)) jobs.push(await readJson(path.join(jobsDir, name)));
    jobs.sort((a, b) => b.startedAt - a.startedAt);
    return { settings: await settings(), activeId: active, jobs: jobs.map(({ report, ...job }) => ({ ...job, findings: report?.length || 0 })), libraries: await listLibraries() };
  }
  async function detail(id) {
    await init();
    if (!ID.test(id)) throw new Error('Invalid recovery job identifier.');
    return readJson(path.join(jobsDir, `${id}.json`));
  }
  async function start(kind, options = {}) {
    await init();
    if (active) throw new Error('Another backup or recovery job is running.');
    const job = { version: 1, id: crypto.randomUUID(), kind, state: 'running', startedAt: Date.now(), processed: 0, bytes: 0, report: [] };
    active = job.id;
    try {
      if (await optionalStat(path.join(stateDir, 'restore.json'))) throw new Error('A restore is scheduled. Restart the application first.');
      if (!['backup', 'verify', 'integrity', 'rebuild', 'restore', 'adopt'].includes(kind)) throw new Error('Unknown recovery operation.');
      await save(job);
    } catch (error) { active = null; throw error; }
    const work = async () => {
      try {
        if (kind === 'integrity') await integrity(job);
        else if (kind === 'rebuild') {
          if (options.confirm !== true) throw new Error('Confirm index reconciliation and thumbnail regeneration.');
          await integrity(job);
          job.report.push(...await rebuild());
        } else if (kind === 'backup') await backupJob(job, options.originals === true);
        else if (kind === 'adopt') {
          const manifest = await verifyBackup(options.directory);
          job.kind = 'backup';
          job.location = await fs.realpath(options.directory);
          job.processed = manifest.files.length;
          job.report.push({ status: 'verified', message: 'Existing backup opened and fully verified. Its files were not modified.' });
        }
        else {
          const previous = await detail(options.backupId);
          if (previous.kind !== 'backup' || previous.state !== 'completed' || !previous.location) throw new Error('Select a completed backup job.');
          const manifest = await verifyBackup(previous.location);
          job.backupId = previous.id;
          job.processed = manifest.files.length;
          if (kind === 'restore') {
            if (options.confirm !== true) throw new Error('Explicit restore confirmation is required.');
            await stageRestore({ userData, directory: previous.location, manifest, job, originals: options.originals === true, currentLibraries: await listLibraries() });
            job.state = 'awaiting_restart';
          } else job.report.push({ status: 'verified', message: `All ${manifest.files.length} backup files and SQLite databases verified.` });
        }
        if (job.state === 'running') job.state = 'completed';
      } catch (error) { job.state = 'failed'; job.error = error.message; }
      finally {
        job.finishedAt = Date.now();
        try { await save(job); } finally { active = null; }
        emit({ kind, state: job.state, error: job.error });
      }
    };
    // Persist the job before detaching its bounded work from the IPC response.
    setImmediate(() => work().catch(error => emit(error)));
    return { id: job.id };
  }
  async function integrity(job) {
    for (const library of await listLibraries()) {
      let index;
      try { index = await readIndex(library.id); }
      catch (error) { job.report.push({ library: library.name, status: 'unreadable_index', message: error.message }); index = { entries: [] }; }
      const entries = new Map(index.entries.map(entry => [entry.path, { ...entry }]));
      for (const asset of syncAssets(library.id)) {
        const entry = entries.get(asset.path);
        if (!entry) entries.set(asset.path, { path: asset.path, size: asset.size, contentHash: asset.sha256 });
        else if (entry.contentHash && asset.sha256 && entry.contentHash !== asset.sha256) entry.conflictingHash = true;
        else if (!entry.contentHash) entry.contentHash = asset.sha256;
      }
      for (const entry of entries.values()) {
        let result;
        try {
          const source = await safePath(library.path, entry.path);
          const stat = await fs.stat(source);
          if (!stat.isFile()) throw new Error('Asset is not a regular file.');
          const hash = entry.contentHash ? await sha256File(source) : null;
          const after = await fs.stat(source);
          result = entry.conflictingHash ? 'conflicting_hashes' : (entry.contentHash ? (hash === entry.contentHash ? 'verified' : 'mismatch') : (entry.size !== null && stat.size !== entry.size ? 'size_mismatch' : 'no_hash'));
          if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) result = 'changed_during_check';
          job.bytes += stat.size;
        } catch (error) {
          result = error.code === 'ENOENT' ? 'missing' : 'unreadable';
          job.report.push({ library: library.name, path: entry.path, status: result, message: error.message });
          job.processed++;
          continue;
        }
        job.report.push({ library: library.name, path: entry.path, status: result });
        job.processed++;
        if (job.processed % 100 === 0) await save(job);
      }
    }
  }
  async function backupJob(job, originals) {
    const destination = await checkDestination((await settings()).destination);
    const partial = path.join(destination, `.mileo-${job.id}.partial`);
    const final = path.join(destination, `mileo-${job.id}`);
    await fs.mkdir(partial);
    job.location = partial;
    await save(job);
    const captured = await capture(path.join(partial, 'metadata'), { originals });
    const manifest = { format: FORMAT, version: 1, id: job.id, createdAt: Date.now(), originals, libraries: captured.libraries, files: [] };
    for (const relative of await inventory(path.join(partial, 'metadata'))) {
      metadataFile(relative);
      const file = await safePath(partial, `metadata/${relative}`);
      const size = (await fs.stat(file)).size;
      manifest.files.push({ kind: 'metadata', relative, path: `metadata/${relative}`, size, sha256: await sha256File(file) });
      job.processed++;
      job.bytes += size;
    }
    if (originals) {
      for (const library of captured.libraries) {
        const scan = captured.scans[library.id];
        if (scan.errors.length || scan.inaccessiblePaths.length) throw new Error(`Library scan is incomplete: ${library.name}. No verified backup was published.`);
        const index = await readJson(path.join(partial, 'metadata', 'photo-library', 'indexes', `${library.id}.json`));
        const entries = new Map(index.entries.map(entry => [entry.path, entry]));
        const found = new Set(scan.files.map(file => file.path));
        for (const entry of index.entries) if (!found.has(entry.path) && !entry.missing) throw new Error(`Indexed original is missing: ${library.name}/${entry.path}`);
        for (const file of scan.files) {
          const relative = relativeFile(file.path);
          const source = await safePath(library.path, relative);
          const backupPath = `originals/${library.id}/${relative}`;
          const info = await copyVerified(source, path.join(partial, ...backupPath.split('/')), entries.get(relative)?.contentHash);
          manifest.files.push({ kind: 'original', libraryId: library.id, relative, path: backupPath, ...info });
          job.processed++;
          job.bytes += info.size;
          if (job.processed % 10 === 0) await save(job);
        }
      }
    }
    await writeJson(path.join(partial, 'manifest.json'), manifest);
    await verifyBackup(partial);
    await fs.rename(partial, final);
    job.location = final;
    job.report.push({ status: 'verified', message: `${manifest.files.length} files verified. ${originals ? 'Original media included.' : 'Metadata only; original media not included.'}` });
  }
  return { init, status, detail, start, configure, busy: () => Boolean(active) };
}

async function stageRestore({ userData, directory, manifest, job, originals, currentLibraries }) {
  if (originals && !manifest.originals) throw new Error('This backup contains metadata only.');
  const root = path.join(userData, 'recovery', `restore-${job.id}`);
  await fs.mkdir(root);
  const files = [];
  for (const file of manifest.files) {
    if (file.kind !== 'metadata' && !originals) continue;
    if (file.kind === 'original') {
      const library = currentLibraries.find(item => item.id === file.libraryId);
      const saved = manifest.libraries.find(item => item.id === file.libraryId);
      if (!library || library.path !== saved.path) throw new Error('Original recovery requires the same registered library paths. Register the destination folders first.');
      await safePath(library.path, file.relative);
    }
    const source = await safePath(directory, file.path);
    await copyVerified(source, path.join(root, ...file.path.split('/')), file.sha256);
    files.push(file);
  }
  await writeJson(path.join(root, 'manifest.json'), { ...manifest, files });
  const metadata = files.filter(file => file.kind === 'metadata').map(file => file.relative);
  // Credentials are deliberately not imported. Save current credentials in rollback, then sign out.
  await writeJson(path.join(root, 'signed-out.json'), { token: '', user: null, localOnly: true });
  files.push({ kind: 'signout', relative: 'auth.json', path: 'signed-out.json' });
  metadata.push('auth.json', 'saved-login.bin', 'account-server/jwt-secret');
  await writeJson(path.join(userData, 'recovery', 'restore.json'), {
    version: 1, jobId: job.id, state: 'prepared', root, files, metadata, originals, libraries: currentLibraries,
    applied: [], rollback: path.join(userData, 'recovery', `rollback-${job.id}`)
  });
}

async function invalidateCredentials(root) {
  for (const [relative, kind] of [['metadata/wifi-sync/wifi-sync.db', 'sync'], ['metadata/account-server/still.db', 'account']]) {
    const file = path.join(root, ...relative.split('/'));
    if (!await optionalStat(file)) continue;
    const db = new DatabaseSync(file);
    try {
      if (kind === 'sync') {
        if (db.prepare('PRAGMA user_version').get().user_version >= 5) db.exec('DELETE FROM family_logins');
        db.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?)').run(Date.now());
        db.exec("DELETE FROM pairing_codes; UPDATE settings SET value = 'false' WHERE key = 'enabled'; UPDATE assets SET state = 'cancelled' WHERE state IN ('discovered','queued','uploading','failed_retryable');");
      } else db.exec("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, datetime('now'));");
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  }
}

async function processPendingRestore(userData) {
  const journalFile = path.join(userData, 'recovery', 'restore.json');
  if (!await optionalStat(journalFile)) return null;
  const journal = await readJson(journalFile);
  if (journal.version !== 1 || !ID.test(journal.jobId) || journal.root !== path.join(userData, 'recovery', `restore-${journal.jobId}`) || journal.rollback !== path.join(userData, 'recovery', `rollback-${journal.jobId}`)) throw new Error('Invalid restore journal. Startup stopped without changing library files.');
  if (!['prepared', 'applying', 'completed'].includes(journal.state) || !Array.isArray(journal.metadata) || !Array.isArray(journal.applied)) throw new Error('Invalid restore journal state.');
  for (const relative of [...journal.metadata, ...journal.applied.map(entry => entry.relative)]) {
    if (!['auth.json', 'saved-login.bin', 'account-server/jwt-secret'].includes(relative)) metadataFile(relative.replace(/-(wal|shm)$/, ''));
  }
  const report = [];
  const jobFile = path.join(userData, 'recovery', 'jobs', `${journal.jobId}.json`);
  const finish = async (state, error) => {
    const job = await readJson(jobFile);
    Object.assign(job, { state, finishedAt: Date.now(), report, rollback: journal.rollback });
    if (error) job.error = error;
    await writeJson(jobFile, job);
    await fs.rename(journalFile, path.join(userData, 'recovery', `restore-${journal.jobId}.finished.json`));
  };
  const rollback = async () => {
    for (const entry of [...journal.applied].reverse()) {
      const target = await safePath(userData, entry.relative);
      const saved = await safePath(journal.rollback, entry.relative);
      if (await optionalStat(saved)) {
        const temp = `${target}.${journal.jobId}.rollback`;
        await fs.copyFile(saved, temp);
        await replace(temp, target);
      } else if (!entry.existed && await optionalStat(target)) {
        // These are allowlisted metadata files only; original media is never removed.
        await fs.rm(target);
      }
      await fs.rm(`${target}.${journal.jobId}.restore`, { force: true });
    }
    report.push({ status: 'rolled_back', message: 'Previous metadata restored. Any newly recovered original files were retained.' });
  };
  if (journal.state === 'applying') {
    await rollback();
    await finish('failed', 'Restore was interrupted. Previous metadata was recovered; review this report before retrying.');
    return { rolledBack: true };
  }
  if (journal.state === 'completed') {
    report.push({ status: 'restored', message: 'Restore completed before shutdown. Pre-restore state is retained in rollback storage.' });
    await finish('completed');
    return { restored: true };
  }
  try {
    await verifyBackup(journal.root);
    await invalidateCredentials(journal.root);
    await fs.mkdir(journal.rollback, { recursive: true });
    journal.state = 'applying';
    await writeJson(journalFile, journal);
    const targets = [...new Set(journal.metadata.flatMap(relative => relative.endsWith('.db') ? [relative, `${relative}-wal`, `${relative}-shm`] : [relative]))];
    for (const relative of targets) {
      if (!['auth.json', 'saved-login.bin', 'account-server/jwt-secret'].includes(relative)) metadataFile(relative.replace(/-(wal|shm)$/, ''));
      const target = await safePath(userData, relative);
      const existing = await optionalStat(target);
      const saved = path.join(journal.rollback, ...relative.split('/'));
      if (existing) {
        if (!existing.isFile()) throw new Error(`Restore target is not a regular metadata file: ${relative}`);
        await fs.mkdir(path.dirname(saved), { recursive: true });
        await fs.copyFile(target, saved, syncFs.constants.COPYFILE_EXCL);
      }
      journal.applied.push({ relative, existed: Boolean(existing) });
      await writeJson(journalFile, journal);
      const record = journal.files.find(file => file.relative === relative && file.kind !== 'original');
      if (record) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${journal.jobId}.restore`;
        await fs.copyFile(await safePath(journal.root, record.path), temp, syncFs.constants.COPYFILE_EXCL);
        await replace(temp, target);
      } else if (relative === 'account-server/jwt-secret') {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeJson(target, crypto.randomBytes(48).toString('hex'));
      } else if (existing) await fs.rm(target);
    }
    for (const file of journal.files.filter(item => item.kind === 'original')) {
      const library = journal.libraries.find(item => item.id === file.libraryId);
      if (!library) throw new Error('Original recovery library is no longer registered.');
      const target = await safePath(library.path, file.relative);
      if (await optionalStat(target)) {
        const same = (await fs.stat(target)).isFile() && await sha256File(target) === file.sha256;
        report.push({ library: library.name, path: file.relative, status: same ? 'already_present' : 'conflict', message: 'Existing original was not overwritten.' });
        continue;
      }
      const temp = `${target}.${journal.jobId}.restore`;
      await copyVerified(await safePath(journal.root, file.path), temp, file.sha256);
      // link() is an atomic, no-replace installation on the same filesystem.
      try { await fs.link(temp, target); } finally { await fs.rm(temp); }
      report.push({ library: library.name, path: file.relative, status: 'restored' });
    }
    report.push({ status: 'restored', message: 'Verified metadata restored. Device credentials and account sessions invalidated. LAN sync is disabled. Pre-restore state retained in rollback storage.' });
    journal.state = 'completed';
    await writeJson(journalFile, journal);
    await finish('completed');
    return { restored: true };
  } catch (error) {
    if (journal.state === 'applying') await rollback();
    await finish('failed', error.message);
    return { failed: true, error: error.message };
  }
}

module.exports = { createBackup, processPendingRestore, captureMetadata, verifyBackup, checkDatabase, safePath, writeJson, inside, reconcileIndex, retireThumbnails };
