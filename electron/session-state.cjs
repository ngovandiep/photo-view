'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const VIEWS = ['photos', 'videos', 'documents', 'timeline', 'folders', 'albums', 'tags', 'favorites', 'recent'];
const KINDS = ['', 'photo', 'video', 'document'];
const SORTS = ['name', 'name-desc', 'date-desc', 'date-asc', 'modified', 'added'];
const SCAN_VERSION = 1;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const validLibraryId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Only known fields survive, so a corrupt or tampered file can never feed arbitrary values to the renderer.
function sanitizeUi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = Number.isInteger(value.page) && value.page >= 0 && value.page < 100000 ? value.page : 0;
  return {
    libraryId: validLibraryId(value.libraryId) ? value.libraryId : '',
    view: VIEWS.includes(value.view) ? value.view : 'photos',
    kind: KINDS.includes(value.kind) ? value.kind : 'photo',
    folder: text(value.folder, 1024),
    collection: text(value.collection, 200),
    search: text(value.search, 200),
    type: text(value.type, 20),
    sort: SORTS.includes(value.sort) ? value.sort : 'name',
    page,
    savedAt: text(value.savedAt, 40)
  };
}

function sanitizeScan(value, libraryPath, maxFiles) {
  if (!value || value.version !== SCAN_VERSION || value.libraryPath !== libraryPath) return null;
  if (!Array.isArray(value.files) || !Array.isArray(value.folders) || !Array.isArray(value.inaccessiblePaths)) return null;
  if (value.files.length > maxFiles) return null;
  const files = [];
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 4096) return null;
    files.push({ path: file.path, size: Number.isFinite(file.size) ? file.size : null, lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null });
  }
  const strings = list => list.filter(item => typeof item === 'string' && item.length <= 4096);
  return { files, folders: strings(value.folders), inaccessiblePaths: strings(value.inaccessiblePaths), processed: Number.isFinite(value.processed) ? value.processed : files.length, scannedAt: text(value.scannedAt, 40) };
}

// UI state is kept per account (like a session cookie); scan results describe the disk, so they are shared per library.
function createSessionStore({ dir, getUserKey, maxFiles = 500000 }) {
  const userDir = async () => {
    const key = String((await getUserKey()) || 'local');
    return path.join(dir, 'users', /^[a-z0-9_-]{1,40}$/i.test(key) ? key : 'local');
  };

  async function writeAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
  const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };

  async function loadUi() {
    return sanitizeUi(await readJson(path.join(await userDir(), 'ui.json')));
  }
  async function saveUi(value) {
    const ui = sanitizeUi(value);
    if (!ui) throw new Error('Invalid session state.');
    ui.savedAt = new Date().toISOString();
    await writeAtomic(path.join(await userDir(), 'ui.json'), ui);
    return ui;
  }
  const scanFile = libraryId => path.join(dir, 'scans', `${libraryId}.json`);
  async function saveScan(libraryId, libraryPath, scan) {
    if (!validLibraryId(libraryId)) throw new Error('Invalid library identifier.');
    await writeAtomic(scanFile(libraryId), {
      version: SCAN_VERSION, libraryPath, scannedAt: new Date().toISOString(),
      files: scan.files, folders: scan.folders, inaccessiblePaths: scan.inaccessiblePaths, processed: scan.processed
    });
  }
  async function loadScan(libraryId, libraryPath) {
    if (!validLibraryId(libraryId)) return null;
    return sanitizeScan(await readJson(scanFile(libraryId)), libraryPath, maxFiles);
  }
  async function clearScan(libraryId) { if (validLibraryId(libraryId)) await fs.rm(scanFile(libraryId), { force: true }); }

  return { loadUi, saveUi, saveScan, loadScan, clearScan };
}

module.exports = { createSessionStore, sanitizeUi, sanitizeScan };
