'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'dng']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp']);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const STORAGE_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTCONN', 'ENETUNREACH', 'EIO']);

class ImportError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function sanitizeFileName(name, fallback = 'photo') {
  let value = String(name || '').normalize('NFC').split(/[\\/]/).pop();
  value = value.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  const dot = value.lastIndexOf('.');
  let base = dot > 0 ? value.slice(0, dot) : value;
  const ext = dot > 0 ? value.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (!base || RESERVED.test(base)) base = `${fallback}_${base || 'file'}`;
  base = base.slice(0, 120);
  return ext ? `${base}.${ext}` : base;
}

function sanitizeSegment(value, fallback) {
  const clean = sanitizeFileName(value, fallback).replace(/\./g, '_').slice(0, 60);
  return clean || fallback;
}

// Phone folder such as "DCIM/Camera" -> safe relative path that mirrors it on the PC (max 8 levels).
function sanitizeFolderPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const segments = value.split(/[\\/]/).map(part => part.trim()).filter(part => part && part !== '.' && part !== '..')
    .slice(0, 8).map(part => sanitizeSegment(part, 'folder'));
  return segments.length ? segments.join('/') : null;
}

function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function classify(filename, mediaType) {
  const extension = extensionOf(filename);
  const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : null;
  if (!kind) throw new ImportError('unsupported_type', `File type ".${extension}" is not accepted.`, 415);
  const declared = String(mediaType || '').toLowerCase();
  if (declared && !declared.startsWith(`${kind}/`) && declared !== 'application/octet-stream') {
    throw new ImportError('unsupported_type', 'Media type does not match the file extension.', 415);
  }
  return { kind, extension };
}

// Verifies the first bytes match the claimed extension, so a renamed file is not stored as a photo.
function sniffMatches(head, extension) {
  const hex = head.subarray(0, 12).toString('hex');
  const ascii = head.subarray(0, 12).toString('latin1');
  const ftyp = ascii.slice(4, 8) === 'ftyp';
  switch (extension) {
    case 'jpg': case 'jpeg': return hex.startsWith('ffd8ff');
    case 'png': return hex.startsWith('89504e47');
    case 'gif': return ascii.startsWith('GIF8');
    case 'bmp': return ascii.startsWith('BM');
    case 'webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'avi': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ';
    case 'ogv': return ascii.startsWith('OggS');
    case 'tif': case 'tiff': case 'dng': return hex.startsWith('49492a00') || hex.startsWith('4d4d002a');
    case 'heic': case 'heif': case 'avif': case 'mp4': case 'mov': case 'm4v': case '3gp': return ftyp;
    case 'webm': case 'mkv': return hex.startsWith('1a45dfa3');
    default: return false;
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const exists = async file => fs.access(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createImporter({ repo, tempDir, resolveLibrary, indexPhoto, findDuplicate = async () => null, statfs = fs.statfs, now = Date.now }) {
  const active = new Set();
  const verifying = new Set();
  let chain = Promise.resolve();
  // Finalizing and indexing run one at a time so file names and index writes never race.
  const serial = work => { const run = chain.then(work, work); chain = run.catch(() => {}); return run; };
  const tempPath = id => path.join(tempDir, `${id}.part`);

  function validateRegistration(meta, settings) {
    const sourceAssetId = typeof meta.sourceAssetId === 'string' ? meta.sourceAssetId.trim() : '';
    if (!sourceAssetId || sourceAssetId.length > 256) throw new ImportError('invalid_asset', 'sourceAssetId is required (max 256 chars).');
    if (!Number.isSafeInteger(meta.size) || meta.size <= 0) throw new ImportError('invalid_asset', 'size must be a positive integer.');
    if (meta.size > settings.maxFileSizeMB * 1024 * 1024) throw new ImportError('too_large', `File exceeds the ${settings.maxFileSizeMB} MB limit.`, 413);
    const filename = sanitizeFileName(meta.filename);
    const { kind } = classify(filename, meta.mediaType);
    const captured = Number.isFinite(meta.capturedAt) ? Math.trunc(meta.capturedAt) : null;
    const expectedSha256 = meta.sha256 === undefined ? null : (typeof meta.sha256 === 'string' ? meta.sha256.toLowerCase() : '');
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ImportError('invalid_asset', 'sha256 must be a 64-character hexadecimal digest.');
    return { sourceAssetId, filename, size: meta.size, kind, mediaType: String(meta.mediaType || '').slice(0, 100), capturedAt: captured, folderPath: sanitizeFolderPath(meta.folderPath), expectedSha256 };
  }

  async function checkSpace(asset, settings) {
    const remaining = asset.size - asset.bytes_received;
    const targets = [tempDir];
    const library = resolveLibrary(settings.destinationLibraryId);
    if (library) targets.push(library.root);
    for (const target of targets) {
      let stats;
      try { stats = await statfs(target); }
      catch (error) {
        if (STORAGE_ERRORS.has(error.code)) throw new ImportError('storage_unavailable', 'Desktop storage is unavailable. Reconnect the drive or NAS and retry.', 503);
        throw error;
      }
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free < remaining + settings.minFreeSpaceMB * 1024 * 1024) throw new ImportError('insufficient_storage', 'Not enough free disk space on the desktop.', 507);
    }
  }

  // Streams request bytes into the temp file at `offset`, with an optional bandwidth cap.
  async function receive(asset, stream, offset, settings) {
    if (active.has(asset.id)) throw new ImportError('upload_in_progress', 'Another upload for this asset is running.', 409);
    active.add(asset.id);
    let handle;
    let written = 0;
    const authorize = () => {
      const problem = repo.family.uploadProblem(asset.device_id, asset);
      if (problem) throw new ImportError('upload_policy', problem, 403);
      if (repo.getAsset(asset.id).state === 'cancelled') throw new ImportError('asset_closed', 'Upload was cancelled.', 409);
    };
    try {
      authorize();
      if (offset !== asset.bytes_received) throw new ImportError('offset_mismatch', `Expected offset ${asset.bytes_received}.`, 409);
      await fs.mkdir(tempDir, { recursive: true });
      await checkSpace(asset, settings);
      authorize();
      handle = await fs.open(tempPath(asset.id), offset === 0 ? 'w' : 'r+');
      authorize();
      repo.update(asset.id, { state: 'uploading', last_error: null });
      const limit = settings.bandwidthLimitKBps * 1024;
      const started = now();
      try {
        for await (const chunk of stream) {
          authorize();
          if (offset + written + chunk.length > asset.size) throw new ImportError('size_exceeded', 'Received more bytes than declared.', 413);
          await handle.write(chunk, 0, chunk.length, offset + written);
          written += chunk.length;
          if (limit > 0) {
            const due = (written / limit) * 1000 - (now() - started);
            if (due > 5) await sleep(Math.min(due, 2000));
          }
        }
        authorize();
      } catch (error) {
        if (repo.getAsset(asset.id).state === 'uploading') repo.update(asset.id, { state: 'queued' });
        throw error;
      } finally {
        // Keep whatever arrived so the client can resume from here after a dropped connection.
        if (written > 0) repo.update(asset.id, { bytes_received: offset + written });
      }
      return { bytesReceived: offset + written, written };
    } finally {
      if (handle) await handle.close().catch(() => {});
      active.delete(asset.id);
    }
  }

  async function chooseDestination(asset, device, settings) {
    const library = resolveLibrary(settings.destinationLibraryId);
    if (!library) throw new ImportError('no_library', 'No destination library is configured.', 409);
    const when = new Date(asset.captured_at || asset.created_at);
    const folder = sanitizeSegment(settings.destinationFolder, 'Wi-Fi Sync');
    const layout = asset.folder_path
      ? asset.folder_path.split('/')
      : [String(when.getUTCFullYear()), String(when.getUTCMonth() + 1).padStart(2, '0')];
    const relDir = [folder, sanitizeSegment(device.name, 'Device'), ...layout];
    return { library, relDir };
  }

  async function moveIntoPlace(temp, rootDir, relDir, filename, assetId, authorize) {
    rootDir = await fs.realpath(rootDir);
    authorize();
    const absDir = path.join(rootDir, ...relDir);
    const resolved = path.resolve(absDir);
    const base = path.resolve(rootDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new ImportError('bad_path', 'Destination escapes the library.', 400);
    await fs.mkdir(absDir, { recursive: true });
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    const staging = path.join(absDir, `.${assetId}.part`);
    await fs.copyFile(temp, staging);
    try {
      for (let n = 0; n < 1000; n += 1) {
        authorize();
        const name = n === 0 ? filename : `${stem} (${n})${ext}`;
        try {
          await fs.link(staging, path.join(absDir, name));
          return [...relDir, name].join('/');
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          if (error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EXDEV') {
            authorize();
            try { await fs.copyFile(staging, path.join(absDir, name), 1); return [...relDir, name].join('/'); }
            catch (inner) { if (inner.code === 'EEXIST') continue; throw inner; }
          }
          throw error;
        }
      }
      throw new ImportError('name_exhausted', 'Could not find a free file name.', 500);
    } finally {
      await fs.rm(staging, { force: true });
    }
  }

  async function indexStored(id) {
    const asset = repo.getAsset(id);
    if (!asset || asset.state !== 'stored') return asset;
    try {
      const library = resolveLibrary(asset.library_id);
      if (!library) throw new Error('Destination library is no longer registered.');
      const file = path.join(library.root, ...asset.library_path.split('/'));
      const stat = await fs.stat(file);
      if (stat.size !== asset.size || !asset.sha256 || await sha256File(file) !== asset.sha256) {
        return repo.failRetryable(id, 'Stored file SHA-256 no longer matches the verified upload.');
      }
      const dateTaken = Number.isFinite(asset.captured_at) ? new Date(asset.captured_at).toISOString() : null;
      await serial(() => indexPhoto(asset.library_id, { path: asset.library_path, size: stat.size, lastModified: Math.round(stat.mtimeMs), dateTaken }, asset.sha256));
      const done = repo.update(id, { state: 'indexed', indexed_at: now(), last_error: null });
      repo.logEvent({ kind: 'upload_imported', message: `${asset.filename} was verified and added to the library.`, deviceId: asset.device_id, sessionId: asset.session_id, result: 'success' });
      return done;
    } catch (error) {
      // The file is safely stored; only indexing is retried.
      return repo.failRetryable(id, `Indexing failed: ${error.message}`);
    }
  }

  async function finalize(id) {
    verifying.add(id);
    try {
      return await serial(async () => {
        const asset = repo.getAsset(id);
        if (!asset || ['cancelled', 'indexed', 'stored'].includes(asset.state)) return asset;
        const authorize = () => {
          const problem = repo.family.uploadProblem(asset.device_id, asset);
          if (problem) throw new ImportError('upload_policy', problem, 403);
          if (repo.getAsset(id).state === 'cancelled') throw new ImportError('asset_closed', 'Upload was cancelled.', 409);
        };
        const temp = tempPath(id);
        try {
          authorize();
          const stat = await fs.stat(temp).catch(() => null);
          if (!stat || stat.size < asset.size) {
            return repo.update(id, { state: 'queued', bytes_received: stat ? stat.size : 0 });
          }
          if (stat.size !== asset.size) return repo.failPermanent(id, 'Uploaded size does not match the declared size.');
          const handle = await fs.open(temp, 'r');
          const head = Buffer.alloc(16);
          await handle.read(head, 0, 16, 0);
          await handle.close();
          if (!sniffMatches(head, extensionOf(asset.filename))) {
            await fs.rm(temp, { force: true });
            return repo.failPermanent(id, 'File content does not match its type.');
          }
          const hash = await sha256File(temp);
          authorize();
          if (asset.expected_sha256 && hash !== asset.expected_sha256) {
            await fs.rm(temp, { force: true });
            return repo.failPermanent(id, 'Uploaded file SHA-256 does not match the declared checksum.');
          }
          const candidates = repo.db.prepare("SELECT * FROM assets WHERE sha256 = ? AND id != ? AND duplicate_of IS NULL AND state IN ('stored','indexed')").all(hash, id);
          let original = null;
          for (const candidate of candidates) {
            if (await existsOnDisk(candidate)) { original = candidate; break; }
            authorize();
          }
          const logDuplicate = () => repo.logEvent({ kind: 'upload_duplicate', message: `${asset.filename} matches a file already in the library; no new copy was created.`, deviceId: asset.device_id, sessionId: asset.session_id, result: 'success' });
          if (original) {
            authorize();
            logDuplicate();
            const done = repo.update(id, { sha256: hash, duplicate_of: original.id, state: 'indexed', stored_at: now(), indexed_at: now(), last_error: 'duplicate' });
            await fs.rm(temp, { force: true });
            return done;
          }
          const settings = repo.getSettings();
          const device = repo.db.prepare('SELECT * FROM devices WHERE id = ?').get(asset.device_id);
          const target = await chooseDestination(asset, device, settings);
          const duplicatePath = await findDuplicate(target.library.id, asset.size, hash);
          authorize();
          if (duplicatePath) {
            authorize();
            logDuplicate();
            const done = repo.update(id, {
              sha256: hash, duplicate_library_path: duplicatePath, library_id: target.library.id,
              library_path: duplicatePath, state: 'indexed', stored_at: now(), indexed_at: now(), last_error: 'duplicate'
            });
            await fs.rm(temp, { force: true });
            return done;
          }
          let relPath = asset.library_path;
          const alreadyPlaced = relPath && await exists(path.join(target.library.root, ...relPath.split('/')));
          if (!alreadyPlaced) relPath = await moveIntoPlace(temp, target.library.root, target.relDir, asset.filename, id, authorize);
          const cancelled = repo.getAsset(id).state === 'cancelled';
          repo.update(id, { state: cancelled ? 'cancelled' : 'stored', sha256: hash, library_id: target.library.id, library_path: relPath, stored_at: now(), last_error: cancelled ? 'Device revoked while committing a verified original; file preserved.' : null });
          await fs.rm(temp, { force: true });
        } catch (error) {
          if (repo.getAsset(id).state === 'indexed') {
            repo.logEvent({ severity: 'warning', kind: 'temporary_cleanup_failed', message: 'A completed duplicate upload left a temporary file; the imported original is unchanged.', deviceId: asset.device_id, result: 'failed' });
            return repo.getAsset(id);
          }
          if (repo.getAsset(id).state === 'cancelled') return repo.getAsset(id);
          if (error instanceof ImportError && error.code === 'upload_policy') {
            repo.update(id, { state: 'queued', last_error: error.message, next_retry_at: null });
            return repo.getAsset(id);
          }
          if (error instanceof ImportError && error.status < 500) return repo.failPermanent(id, error.message);
          return repo.failRetryable(id, error.message);
        }
        return repo.getAsset(id);
      }).then(async result => (result && result.state === 'stored' ? indexStored(id) : result));
    } finally {
      verifying.delete(id);
    }
  }

  // Applies the right recovery for a failed or interrupted asset.
  async function retry(id) {
    const asset = repo.getAsset(id);
    if (!asset || !['failed_retryable', 'failed_permanent', 'uploading', 'stored'].includes(asset.state)) return asset;
    if (asset.library_path && asset.stored_at) {
      repo.update(id, { state: 'stored', next_retry_at: null });
      return indexStored(id);
    }
    if (asset.bytes_received >= asset.size) {
      repo.update(id, { state: 'uploading', next_retry_at: null });
      return finalize(id);
    }
    return repo.update(id, { state: 'queued', next_retry_at: null, last_error: null });
  }

  // Run on startup: reconcile the byte counters with what is really on disk, then finish interrupted work.
  async function recover() {
    const rows = repo.db.prepare("SELECT id FROM assets WHERE state IN ('queued','uploading','stored')").all();
    if (rows.length) repo.logEvent({ kind: 'recovery', message: `Recovering ${rows.length} interrupted upload(s) after startup.` });
    for (const { id } of rows) {
      const asset = repo.getAsset(id);
      if (asset.state === 'stored') { await indexStored(id); continue; }
      const stat = await fs.stat(tempPath(id)).catch(() => null);
      const size = stat ? Math.min(stat.size, asset.size) : 0;
      if (size !== asset.bytes_received) repo.update(id, { bytes_received: size });
      if (size >= asset.size) await finalize(id);
      else if (asset.state === 'uploading') repo.update(id, { state: 'queued' });
    }
  }

  async function discardTemp(id) { await fs.rm(tempPath(id), { force: true }); }
  async function existsOnDisk(asset) {
    const library = asset.library_path && resolveLibrary(asset.library_id);
    if (!library) return false;
    const file = path.join(library.root, ...asset.library_path.split('/'));
    try {
      const stat = await fs.stat(file);
      return stat.isFile() && stat.size === asset.size && Boolean(asset.sha256) && await sha256File(file) === asset.sha256;
    } catch (error) {
      if (STORAGE_ERRORS.has(error.code)) return false;
      throw error;
    }
  }
  const isActive = id => active.has(id);

  return { validateRegistration, receive, finalize, indexStored, retry, recover, discardTemp, existsOnDisk, isActive, isVerifying: id => verifying.has(id), tempPath };
}

module.exports = { createImporter, ImportError, sanitizeFileName, sanitizeFolderPath, classify, sniffMatches, sha256File, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS };
