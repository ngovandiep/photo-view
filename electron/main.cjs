'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const crypto = require('node:crypto');
const permissions = require('./permissions.cjs');
const { createSessionStore } = require('./session-state.cjs');
const { constants: fsConstants, createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const indexStore = require('../index-store.js');
const { convertHeicPreview } = require('./photo-preview.cjs');
const { createBrandingStore } = require('./branding.cjs');
const { createBackup, processPendingRestore, captureMetadata, reconcileIndex, retireThumbnails } = require('./backup.cjs');

// The product was renamed to MiLeo Photo Library; keep the original data folder so existing libraries,
// accounts, Wi-Fi pairings and encrypted secrets stay available after the upgrade.
app.setPath('userData', path.join(app.getPath('appData'), 'Still Photo Library'));
const branding = createBrandingStore({ file: path.join(app.getPath('userData'), 'branding.json') });

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'dng']);
const videoExtensions = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp']);
const documentExtensions = new Set(['pdf']);
const mediaMimeTypes = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo', '3gp': 'video/3gpp', pdf: 'application/pdf' };
protocol.registerSchemesAsPrivileged([{ scheme: 'still-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const maxIndexBytes = 100 * 1024 * 1024;
const maxPhotoBytes = 512 * 1024 * 1024;
const maxIndexedFiles = 500000;
let mainWindow;
let syncService;
let backupService;
let libraryMaintenance = false;
const libraryWriters = new Set();
function libraryWrite(work) {
  if (libraryMaintenance) return Promise.reject(new Error('Library maintenance is in progress. Try again when the recovery job finishes.'));
  const pending = Promise.resolve().then(work);
  libraryWriters.add(pending);
  pending.then(() => libraryWriters.delete(pending), () => libraryWriters.delete(pending));
  return pending;
}
async function maintainLibrary(work) {
  if (libraryMaintenance) throw new Error('Library maintenance is already running.');
  if (!syncService || syncService.status().running) throw new Error('Pause receiving in Upload queue before backup or index recovery.');
  libraryMaintenance = true;
  try {
    await Promise.all([...libraryWriters]);
    if (syncService.repo.db.prepare('SELECT id FROM assets').all().some(row => syncService.importer.isActive(row.id) || syncService.importer.isVerifying(row.id))) {
      throw new Error('An upload is still finishing. Wait before starting maintenance.');
    }
    return await work();
  } finally { libraryMaintenance = false; }
}

function dataDirectory() { return path.join(app.getPath('userData'), 'photo-library'); }
function manifestPath() { return path.join(dataDirectory(), 'libraries.json'); }
function indexDirectory() { return path.join(dataDirectory(), 'indexes'); }
function backupDirectory() { return path.join(dataDirectory(), 'backups'); }
function indexPath(libraryId) {
  if (typeof libraryId !== 'string' || !/^[a-f0-9]{64}$/.test(libraryId)) throw new Error('Invalid photo library identifier.');
  return path.join(indexDirectory(), `${libraryId}.json`);
}
function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function normalizeRootIdentity(root) {
  const normalized = path.resolve(root).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function idForRoot(root) { return crypto.createHash('sha256').update(normalizeRootIdentity(root)).digest('hex'); }
function newManifest() { return { format: 'still-photo-library-roots', version: 1, libraries: [] }; }

const writeQueues = new Map();
async function renameWithRetry(from, to) {
  // Windows refuses to replace a file that antivirus, the search indexer or a reader briefly holds open.
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      if (attempt >= 8) { await fs.copyFile(from, to); return; }
      await new Promise(resolve => setTimeout(resolve, 40 * 2 ** Math.min(attempt, 5)));
    }
  }
}
function writeJsonAtomic(file, value) {
  const run = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(() => writeJsonOnce(file, value));
  writeQueues.set(file, run);
  run.catch(() => {}).then(() => { if (writeQueues.get(file) === run) writeQueues.delete(file); });
  return run;
}
async function writeJsonOnce(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await renameWithRetry(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(temporary, { force: true }).catch(() => {});
}

async function readManifest() {
  try {
    const contents = await fs.readFile(manifestPath(), 'utf8');
    const manifest = JSON.parse(contents);
    if (manifest.format !== 'still-photo-library-roots' || manifest.version !== 1 || !Array.isArray(manifest.libraries)) throw new Error('The saved photo-folder list has an unsupported format. It was not changed.');
    return manifest;
  } catch (error) {
    if (error.code === 'ENOENT') return newManifest();
    throw error;
  }
}

async function registeredLibrary(libraryId) {
  const manifest = await readManifest();
  const library = manifest.libraries.find(item => item.id === libraryId);
  if (!library || idForRoot(library.path) !== library.id) throw new Error('This photo folder is not registered. Add it again to grant access.');
  return library;
}

async function libraryStatus(library) {
  try {
    const directory = await fs.realpath(library.path);
    const details = await fs.stat(directory);
    if (!details.isDirectory() || normalizeRootIdentity(directory) !== normalizeRootIdentity(library.path)) throw new Error('The registered folder path changed.');
    return { ...library, available: true, warning: '' };
  } catch (error) {
    return { ...library, available: false, warning: error.code === 'ENOENT' ? 'Folder not found. Reconnect it to browse photos.' : `Folder unavailable (${error.code || 'access denied'}). Reconnect it to browse photos.` };
  }
}

function registerFolders(paths) { return libraryWrite(() => registerFoldersWork(paths)); }
async function registerFoldersWork(paths) {
  const manifest = await readManifest();
  const entries = new Map(manifest.libraries.map(library => [library.id, library]));
  const registered = [];
  for (const selectedPath of paths) {
    let root;
    try { root = await fs.realpath(selectedPath); } catch { continue; }
    const details = await fs.stat(root);
    if (!details.isDirectory()) continue;
    const id = idForRoot(root);
    const library = entries.get(id) || { id, path: root, name: path.basename(root), addedAt: new Date().toISOString(), lastScannedAt: null };
    entries.set(id, library);
    registered.push(await libraryStatus(library));
  }
  if (registered.length) {
    manifest.libraries = [...entries.values()];
    await writeJsonAtomic(manifestPath(), manifest);
  }
  return registered;
}

async function readIndex(libraryId) {
  const library = await registeredLibrary(libraryId);
  try {
    const stat = await fs.stat(indexPath(libraryId));
    if (stat.size > maxIndexBytes) throw new Error('Saved index exceeds the 100 MB safety limit.');
    const validated = indexStore.validate(JSON.parse(await fs.readFile(indexPath(libraryId), 'utf8')));
    if (!validated.ok) throw new Error(`Saved index could not be loaded: ${validated.error}`);
    if (validated.index.root !== library.name) throw new Error('Saved index root does not match its registered photo folder. The index was not changed.');
    return validated.index;
  } catch (error) {
    if (error.code === 'ENOENT') return indexStore.create(library.name);
    throw error;
  }
}

function saveIndex(libraryId, candidate) { return libraryWrite(() => saveIndexWork(libraryId, candidate)); }
async function saveIndexWork(libraryId, candidate) {
  const library = await registeredLibrary(libraryId);
  const validation = indexStore.validate(candidate);
  if (!validation.ok) throw new Error(`Index validation failed: ${validation.error}`);
  if (validation.index.root !== library.name) throw new Error('Index root does not match the registered photo folder.');
  const json = JSON.stringify(validation.index, null, 2);
  if (Buffer.byteLength(json, 'utf8') > maxIndexBytes) throw new Error('Index exceeds the 100 MB safety limit.');
  await writeJsonAtomic(indexPath(libraryId), validation.index);
  const manifest = await readManifest();
  const item = manifest.libraries.find(entry => entry.id === libraryId);
  if (item) item.lastScannedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath(), manifest);
  return { saved: true, entryCount: validation.index.entries.length };
}

async function backupExistingIndex(libraryId) {
  const source = indexPath(libraryId);
  try { await fs.access(source); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await fs.mkdir(backupDirectory(), { recursive: true });
  const destination = path.join(backupDirectory(), `${libraryId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  return destination;
}

async function backupLegacyMetadata(libraryId, legacy) {
  await registeredLibrary(libraryId);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Legacy annotations must be a JSON object.');
  if (Buffer.byteLength(JSON.stringify(legacy), 'utf8') > 50 * 1024 * 1024) throw new Error('Legacy annotations exceed the 50 MB backup limit.');
  await fs.mkdir(backupDirectory(), { recursive: true });
  const destination = path.join(backupDirectory(), `${libraryId}-legacy-${crypto.randomUUID()}.json`);
  await writeJsonAtomic(destination, legacy);
  return destination;
}

function scanLibrary(event, libraryId, requestId) { return libraryWrite(() => scanLibraryWork(event, libraryId, requestId)); }
async function scanLibraryWork(event, libraryId, requestId) {
  const library = await registeredLibrary(libraryId);
  let root;
  try { root = await fs.realpath(library.path); }
  catch (error) { return { files: [], folders: [], inaccessiblePaths: [''], errors: [{ path: '', code: error.code || 'ACCESS_DENIED' }] }; }
  const files = [];
  const folders = new Set();
  const inaccessiblePaths = [];
  const errors = [];
  const pending = [{ absolute: root, relative: '' }];
  let processed = 0;
  let limitReached = false;

  while (pending.length) {
    const directory = pending.pop();
    try {
      const entries = await fs.readdir(directory.absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '__MACOSX' || entry.name.startsWith('._') || entry.isSymbolicLink()) continue;
        const relativePath = indexStore.normalizePath(directory.relative ? `${directory.relative}/${entry.name}` : entry.name);
        if (entry.isDirectory()) {
          folders.add(relativePath);
          pending.push({ absolute: path.join(directory.absolute, entry.name), relative: relativePath });
        } else if (entry.isFile()) {
          processed++;
          const extension = path.extname(entry.name).slice(1).toLowerCase();
          if (imageExtensions.has(extension) || videoExtensions.has(extension) || documentExtensions.has(extension)) {
            try {
              const stats = await fs.stat(path.join(directory.absolute, entry.name));
              files.push({ path: relativePath, size: stats.size, lastModified: Math.round(stats.mtimeMs) });
            } catch (error) {
              inaccessiblePaths.push(relativePath);
              errors.push({ path: relativePath, code: error.code || 'ACCESS_DENIED' });
            }
          }
          if (files.length > maxIndexedFiles) {
            limitReached = true;
            inaccessiblePaths.push('');
            errors.push({ path: '', code: 'INDEX_LIMIT' });
            pending.length = 0;
            break;
          }
        }
        if (processed && processed % 250 === 0) {
          event.sender.send('library:progress', { requestId, libraryId, processed, imageCount: files.length, folder: directory.relative });
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      inaccessiblePaths.push(directory.relative);
      errors.push({ path: directory.relative, code: error.code || 'ACCESS_DENIED' });
    }
    if (limitReached) break;
  }

  const manifest = await readManifest();
  const item = manifest.libraries.find(entry => entry.id === libraryId);
  if (item) item.lastScannedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath(), manifest);
  const result = { files, folders: [...folders], inaccessiblePaths, errors, processed };
  await sessionStore().saveScan(libraryId, library.path, result).catch(() => {});
  return result;
}

async function readPhoto(libraryId, relativePath) {
  const library = await registeredLibrary(libraryId);
  const safeRelative = indexStore.normalizePath(relativePath);
  const extension = path.extname(safeRelative).slice(1).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error('This file type is not an indexed image format.');
  const root = await fs.realpath(library.path);
  const candidate = path.resolve(root, ...safeRelative.split('/'));
  if (!isInside(root, candidate)) throw new Error('Photo path must remain inside its registered folder.');
  const resolvedFile = await fs.realpath(candidate);
  if (!isInside(root, resolvedFile)) throw new Error('Photo resolves outside its registered folder.');
  const stats = await fs.stat(resolvedFile);
  if (!stats.isFile()) throw new Error('Photo path is not a regular file.');
  if (stats.size > maxPhotoBytes) throw new Error('Photo exceeds the 512 MB preview limit.');
  return new Uint8Array(await fs.readFile(resolvedFile));
}

async function readPhotoPreview(libraryId, relativePath) {
  const bytes = await readPhoto(libraryId, relativePath);
  const extension = path.extname(relativePath).slice(1).toLowerCase();
  return extension === 'heic' || extension === 'heif' ? convertHeicPreview(Buffer.from(bytes)) : bytes;
}

// Streams a registered library's video with HTTP range support so large files seek without loading into memory.
async function handleMediaRequest(request) {
  try {
    const url = new URL(request.url);
    const library = await registeredLibrary(url.hostname);
    const safeRelative = indexStore.normalizePath(decodeURIComponent(url.pathname.slice(1)));
    const mediaExtension = path.extname(safeRelative).slice(1).toLowerCase();
    if (!videoExtensions.has(mediaExtension) && !documentExtensions.has(mediaExtension)) return new Response('Unsupported', { status: 415 });
    const root = await fs.realpath(library.path);
    const candidate = path.resolve(root, ...safeRelative.split('/'));
    if (!isInside(root, candidate)) return new Response('Forbidden', { status: 403 });
    const resolvedFile = await fs.realpath(candidate);
    if (!isInside(root, resolvedFile)) return new Response('Forbidden', { status: 403 });
    const stats = await fs.stat(resolvedFile);
    if (!stats.isFile()) return new Response('Not found', { status: 404 });
    // Node's fs opens files with delete-sharing, so playing a file never blocks renaming its folder (net.fetch on file:// does).
    const size = stats.size;
    let start = 0; let end = size - 1; let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      else { start = Math.max(0, size - Number(range[2])); }
      if (start >= size || start > end) return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
    }
    const headers = { 'Content-Type': mediaMimeTypes[mediaExtension] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(size ? end - start + 1 : 0) };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (!size) return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(resolvedFile, { start, end })), { status, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Windows reports EPERM/EBUSY while any process (including this app's media previews, antivirus or Explorer) holds a file open.
async function renameWithRetry(from, to) {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!transient.has(error.code)) throw error;
      if (attempt >= 7) throw new Error('Windows would not rename this folder because something is using a file inside it (for example a File Explorer preview or window, a media player, a backup/sync tool or antivirus). Close anything that has this folder open and try again.');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function moveFolder(libraryId, fromRelative, toRelative) { return libraryWrite(() => moveFolderWork(libraryId, fromRelative, toRelative)); }
async function moveFolderWork(libraryId, fromRelative, toRelative) {
  const library = await registeredLibrary(libraryId);
  const from = indexStore.normalizePath(fromRelative);
  const to = indexStore.normalizePath(toRelative);
  const segments = to.split('/');
  if (segments.some(part => /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) throw new Error('The new folder name contains characters Windows does not allow.');
  if (to === from || to.startsWith(`${from}/`)) throw new Error('A folder cannot be moved into itself.');
  const root = await fs.realpath(library.path);
  const source = path.resolve(root, ...from.split('/'));
  const target = path.resolve(root, ...segments);
  if (!isInside(root, source) || !isInside(root, target)) throw new Error('Folders must stay inside the photo library.');
  const sourceReal = await fs.realpath(source);
  if (!isInside(root, sourceReal) || !(await fs.stat(sourceReal)).isDirectory()) throw new Error('The source folder is not available.');
  const parent = await fs.realpath(path.dirname(target)).catch(() => null);
  if (!parent || (parent !== root && !isInside(root, parent))) throw new Error('The destination folder does not exist.');
  if (await fs.access(target).then(() => true, () => false)) throw new Error('An item with that name already exists at the destination.');
  const { index } = indexStore.moveFolder(await readIndex(libraryId), from, to);
  await renameWithRetry(sourceReal, target);
  try {
    await saveIndexWork(libraryId, index);
  } catch (error) {
    await renameWithRetry(target, sourceReal).catch(() => {});
    throw error;
  }
  await sessionStore().clearScan(libraryId).catch(() => {});
  app.emit('library-folder-moved', libraryId, from, to);
  return { moved: true, from, to };
}

// Writes are enforced here, not just hidden in the UI. Signed-out and view-only roles are read-only.
let accountAuth = null;
let sessionStoreInstance = null;
// UI state follows the signed-in account; the scan cache is shared per library.
const sessionStore = () => sessionStoreInstance || (sessionStoreInstance = createSessionStore({
  dir: path.join(app.getPath('userData'), 'session'),
  getUserKey: async () => { const user = accountAuth ? await accountAuth.getUser() : null; return user && Number.isInteger(user.id) ? `u${user.id}` : 'local'; },
  maxFiles: maxIndexedFiles
}));
const requireCapability = (capability, work) => async (...args) => {
  const role = accountAuth ? await accountAuth.getRole() : 'viewer';
  if (!permissions.can(role, capability)) throw new Error(capability === 'sync' ? 'Your role is view-only and cannot manage Wi-Fi sync.' : 'Your role is view-only and cannot change the library.');
  return work(...args);
};

function registerIpc() {
  ipcMain.handle('folder:move', requireCapability('edit', (_event, libraryId, from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error('Invalid folder request.');
    return moveFolder(libraryId, from, to);
  }));
  ipcMain.handle('library:list', async () => {
    const manifest = await readManifest();
    return Promise.all(manifest.libraries.map(libraryStatus));
  });
  ipcMain.handle('library:choose-folders', requireCapability('edit', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Select photo folders', properties: ['openDirectory', 'multiSelections'] });
    return result.canceled ? [] : registerFolders(result.filePaths);
  }));
  ipcMain.handle('library:scan', (event, libraryId, requestId) => {
    if (typeof requestId !== 'string' || requestId.length > 64) throw new Error('Invalid scan request.');
    return scanLibrary(event, libraryId, requestId);
  });
  ipcMain.handle('session:load', () => sessionStore().loadUi());
  ipcMain.handle('session:save', (_event, ui) => sessionStore().saveUi(ui));
  ipcMain.handle('library:cached-scan', async (_event, libraryId) => {
    const library = await registeredLibrary(libraryId);
    return sessionStore().loadScan(libraryId, library.path);
  });
  ipcMain.handle('index:load', (_event, libraryId) => readIndex(libraryId));
  ipcMain.handle('index:save', requireCapability('edit', (_event, libraryId, index) => saveIndex(libraryId, index)));
  ipcMain.handle('index:backup', (_event, libraryId) => backupExistingIndex(libraryId));
  ipcMain.handle('index:backup-legacy', requireCapability('edit', (_event, libraryId, metadata) => backupLegacyMetadata(libraryId, metadata)));
  ipcMain.handle('index:import', requireCapability('edit', async (_event, libraryId) => {
    await registeredLibrary(libraryId);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import photo index', properties: ['openFile'], filters: [{ name: 'JSON index', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > maxIndexBytes) throw new Error('Selected index exceeds the 100 MB import limit.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }));
  ipcMain.handle('index:export', async (_event, libraryId, index) => {
    await registeredLibrary(libraryId);
    const validation = indexStore.validate(index);
    if (!validation.ok) throw new Error(`Index validation failed: ${validation.error}`);
    const json = JSON.stringify(validation.index, null, 2);
    if (Buffer.byteLength(json, 'utf8') > maxIndexBytes) throw new Error('Index exceeds the 100 MB export limit.');
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export photo index', defaultPath: `still-index-${libraryId.slice(0, 12)}.json`, filters: [{ name: 'JSON index', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    let existing = false;
    try { await fs.access(result.filePath); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      const confirm = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0, message: 'Replace the existing JSON file?', detail: 'This replaces only the selected index file, not any photos.' });
      if (confirm.response !== 1) return false;
    }
    await fs.writeFile(result.filePath, json, 'utf8');
    return true;
  });
  ipcMain.handle('photo:read', (_event, libraryId, relativePath) => readPhoto(libraryId, relativePath));
  ipcMain.handle('photo:preview', (_event, libraryId, relativePath) => readPhotoPreview(libraryId, relativePath));
  ipcMain.handle('window:toggle-fullscreen', () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); return !!mainWindow?.isFullScreen(); });
  ipcMain.handle('window:is-fullscreen', () => !!mainWindow?.isFullScreen());
  ipcMain.handle('branding:get', () => branding.get());
}

function brandingChanged() {
  const value = branding.get();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setTitle(value.appName);
    win.webContents.send('branding:changed', value);
  }
}

// Only the website configured in Branding may leave the app, and it opens in the system browser.
function openBrandWebsite(target) {
  const site = branding.get().websiteUrl;
  if (site && target === site) require('electron').shell.openExternal(site).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: branding.get().appName,
    width: 1440,
    height: 940,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#fafbfa',
    icon: path.join(app.getAppPath(), 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const applicationRoot = path.resolve(app.getAppPath());
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const targetUrl = new URL(target);
        const localPath = targetUrl.protocol === 'file:' ? path.resolve(fileURLToPath(targetUrl)) : '';
      if (!localPath || !isInside(applicationRoot, localPath)) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openBrandWebsite(url); return { action: 'deny' }; });
  // Keep the configured name instead of the page <title> while the renderer is loading.
  mainWindow.on('page-title-updated', event => { event.preventDefault(); mainWindow.setTitle(branding.get().appName); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) dialog.showErrorBox(`${branding.get().appName} could not load`, `${description} (${code})`);
  });
  mainWindow.loadFile(path.join(applicationRoot, 'index.html')).catch(error => dialog.showErrorBox(`${branding.get().appName} could not start`, error.message));
  mainWindow.on('closed', () => { mainWindow = null; });
}

let accountServer;
let accountDb = null;
let accountChat = null;
async function startAccountServer() {
  const directory = path.join(app.getPath('userData'), 'account-server');
  await fs.mkdir(directory, { recursive: true });
  // The signing secret is kept stable so sessions survive restarts.
  const secretFile = path.join(directory, 'jwt-secret');
  let secret = process.env.JWT_SECRET || await fs.readFile(secretFile, 'utf8').catch(() => '');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(secretFile, secret, { encoding: 'utf8', mode: 0o600 });
  }
  const { openDb } = require('../server/db');
  const { createApp } = require('../server/app');
  const database = openDb(process.env.DB_PATH || path.join(directory, 'still.db'));
  const server = createApp(database, { secret });
  await new Promise((resolve, reject) => {
    server.once('error', error => (error.code === 'EADDRINUSE' ? resolve() : reject(error)));
    server.listen(Number(process.env.PORT) || 3000, '127.0.0.1', () => { accountServer = server; accountDb = database; accountChat = server.chat; startChatMaintenance(); resolve(); });
  });
}
// Chat history is kept for 90 days; the admin window is told about activity without message bodies.
function startChatMaintenance() {
  const purge = () => { try { accountChat.purge(90); } catch (error) { console.error('Chat purge failed:', error.message); } };
  purge();
  setInterval(purge, 6 * 60 * 60 * 1000).unref();
  accountChat.hub.on('admin', event => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('admin:chat-event', { type: event.type, userId: event.userId, unread: accountChat.unreadForAdmin() });
  });
}
// Password hashes are never selected; the admin dashboard only sees profile fields.
const userAdmin = () => {
  if (!accountDb) throw new Error('The account directory is not available from this app.');
  return require('../server/admin-users').createUserAdmin(accountDb);
};
const listAccountUsers = () => (accountDb ? userAdmin().list() : null);
const createAccountUser = input => userAdmin().create(input || {});
const setAccountUserRole = (userId, role) => userAdmin().setRole(userId, role);
// Disabling blocks sign-in and any existing token immediately; the user's data is kept so access can be restored.
const setAccountUserDisabled = (userId, disabled) => {
  if (!accountDb) throw new Error('The account directory is not available from this app.');
  const found = accountDb.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(userId));
  if (!found) throw new Error('User not found.');
  accountDb.prepare(disabled ? "UPDATE users SET disabled_at = COALESCE(disabled_at, datetime('now')) WHERE id = ?" : 'UPDATE users SET disabled_at = NULL WHERE id = ?').run(found.id);
  if (disabled) accountDb.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE user_id = ?").run(found.id);
  return { id: found.id, email: found.email };
};
app.on('will-quit', () => { if (accountServer) accountServer.close(); });

const hasInstance = app.requestSingleInstanceLock();
if (!hasInstance) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    if ((process.env.DB_PATH || process.env.STILL_API_URL || process.env.JWT_SECRET) && await fs.access(path.join(app.getPath('userData'), 'recovery', 'restore.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error('A restore is pending. Remove DB_PATH, STILL_API_URL and JWT_SECRET overrides before starting MiLeo so local database recovery and session invalidation can be completed safely.');
    }
    const recovery = await processPendingRestore(app.getPath('userData'));
    if (recovery?.failed || recovery?.rolledBack) {
      dialog.showErrorBox('MiLeo recovery report', recovery.error || 'An interrupted restore was rolled back. Review Backup & Recovery before retrying.');
    }
    if (process.platform === 'win32') app.setAppUserModelId('com.still.photolibrary');
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    protocol.handle('still-media', handleMediaRequest);
    registerIpc();
    const authApi = accountAuth = require('./auth.cjs').register({
      app,
      ipcMain,
      safeStorage: require('electron').safeStorage,
      libraries: {
        list: async () => (await readManifest()).libraries,
        read: readIndex,
        save: saveIndex
      }
    });
    const userChat = require('./chat-client.cjs').register({ ipcMain, auth: { ...authApi.chatContext }, BrowserWindow, Notification: require('electron').Notification, appName: () => branding.get().appName });
    backupService = createBackup({
      userData: app.getPath('userData'),
      listLibraries: async () => (await readManifest()).libraries,
      readIndex,
      syncAssets: libraryId => syncService.db.prepare("SELECT library_path AS path, size, sha256 FROM assets WHERE library_id = ? AND library_path IS NOT NULL AND sha256 IS NOT NULL AND stored_at IS NOT NULL").all(libraryId),
      emit: result => {
        if (result instanceof Error) {
          console.error('Recovery job could not be saved:', result.message);
          dialog.showErrorBox('MiLeo backup or recovery failed', `The job result could not be saved: ${result.message}. Review the backup destination before retrying.`);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (result?.kind === 'rebuild') {
            if (result.state === 'failed') dialog.showErrorBox('MiLeo index recovery failed', `${result.error}\n\nReview the recovery report. Completed per-library changes and previous index copies were retained.`);
            mainWindow.webContents.reload();
          }
          else mainWindow.webContents.send('wifi-sync:event', { type: 'recovery-job' });
        }
      },
      capture: (destination, options) => maintainLibrary(async () => {
        if (process.env.DB_PATH || process.env.STILL_API_URL || process.env.JWT_SECRET || !accountDb) throw new Error('M4 snapshots require the embedded account database and signing secret at their default locations. External account databases and secret overrides are not supported.');
        const libraries = (await readManifest()).libraries;
        await writeJsonAtomic(manifestPath(), { ...(await readManifest()), libraries });
        const scans = {};
        for (const library of libraries) {
          if (options.originals) scans[library.id] = await scanLibraryWork({ sender: { send() {} } }, library.id, 'backup');
          await writeJsonAtomic(indexPath(library.id), await readIndex(library.id));
        }
        // All application-side JSON writers are drained. Synchronous snapshots prevent
        // account and sync callbacks from interleaving between the metadata copies.
        captureMetadata(app.getPath('userData'), destination, {
          'wifi-sync/wifi-sync.db': syncService.db,
          'account-server/still.db': accountDb
        });
        return { libraries, scans };
      }),
      rebuild: () => maintainLibrary(async () => {
        const report = [];
        for (const library of (await readManifest()).libraries) {
          await backupExistingIndex(library.id);
          let previous;
          let damagedIndex = false;
          try { previous = await readIndex(library.id); }
          catch (error) {
            damagedIndex = true;
            previous = indexStore.create(library.name);
            report.push({ library: library.name, status: 'damaged_index_preserved', message: `Previous index retained in photo-library/backups. Its unreadable annotations cannot be merged: ${error.message}` });
          }
          const scan = await scanLibraryWork({ sender: { send() {} } }, library.id, 'recovery');
          if (damagedIndex && scan.errors.length) throw new Error(`Cannot replace the damaged index for ${library.name} with an incomplete scan. Previous index was retained.`);
          const result = reconcileIndex(previous, scan);
          await saveIndexWork(library.id, result.index);
          report.push({ library: library.name, status: scan.errors.length ? 'partial' : 'reconciled', ...result.summary, errors: scan.errors });
        }
        await retireThumbnails(app.getPath('userData'), (await readManifest()).libraries);
        report.push({ status: 'cache_reset', message: 'Thumbnail cache retired; previews regenerate on demand. Reload the library to clear in-memory previews.' });
        return report;
      })
    });
    await backupService.init();
    syncService = require('./wifi-sync/ipc.cjs').register({
      app,
      ipcMain,
      safeStorage: require('electron').safeStorage,
      getWindow: () => mainWindow,
      manifestPath,
      readIndex,
      saveIndex,
      indexStore,
      getAccount: authApi.getUser,
      verifyLogin: authApi.verifyLogin,
      permit: async capability => permissions.can(await authApi.getRole(), capability),
      listAccountUsers,
      setAccountUserDisabled,
      createAccountUser,
      setAccountUserRole,
      getChat: () => accountChat,
      userChat,
      branding,
      backup: backupService,
      onBrandingChanged: brandingChanged
    });
    await startAccountServer().catch(error => console.error('Account server did not start:', error.message));
    createWindow();
  }).catch(error => {
    dialog.showErrorBox(`${branding.get().appName} could not start`, error.message);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}