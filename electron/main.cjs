'use strict';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const indexStore = require('../index-store.js');

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'dng']);
const maxIndexBytes = 100 * 1024 * 1024;
const maxPhotoBytes = 512 * 1024 * 1024;
const maxIndexedFiles = 500000;
let mainWindow;

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

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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

async function registerFolders(paths) {
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

async function saveIndex(libraryId, candidate) {
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

async function scanLibrary(event, libraryId, requestId) {
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
          if (imageExtensions.has(extension)) {
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
  return { files, folders: [...folders], inaccessiblePaths, errors, processed };
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

function registerIpc() {
  ipcMain.handle('library:list', async () => {
    const manifest = await readManifest();
    return Promise.all(manifest.libraries.map(libraryStatus));
  });
  ipcMain.handle('library:choose-folders', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Select photo folders', properties: ['openDirectory', 'multiSelections'] });
    return result.canceled ? [] : registerFolders(result.filePaths);
  });
  ipcMain.handle('library:scan', (event, libraryId, requestId) => {
    if (typeof requestId !== 'string' || requestId.length > 64) throw new Error('Invalid scan request.');
    return scanLibrary(event, libraryId, requestId);
  });
  ipcMain.handle('index:load', (_event, libraryId) => readIndex(libraryId));
  ipcMain.handle('index:save', (_event, libraryId, index) => saveIndex(libraryId, index));
  ipcMain.handle('index:backup', (_event, libraryId) => backupExistingIndex(libraryId));
  ipcMain.handle('index:backup-legacy', (_event, libraryId, metadata) => backupLegacyMetadata(libraryId, metadata));
  ipcMain.handle('index:import', async (_event, libraryId) => {
    await registeredLibrary(libraryId);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import photo index', properties: ['openFile'], filters: [{ name: 'JSON index', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > maxIndexBytes) throw new Error('Selected index exceeds the 100 MB import limit.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  });
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
  ipcMain.handle('window:toggle-fullscreen', () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); return !!mainWindow?.isFullScreen(); });
  ipcMain.handle('window:is-fullscreen', () => !!mainWindow?.isFullScreen());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Still Photo Library',
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) dialog.showErrorBox('Still could not load', `${description} (${code})`);
  });
  mainWindow.loadFile(path.join(applicationRoot, 'index.html')).catch(error => dialog.showErrorBox('Still could not start', error.message));
  mainWindow.on('closed', () => { mainWindow = null; });
}

const hasInstance = app.requestSingleInstanceLock();
if (!hasInstance) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.still.photolibrary');
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpc();
    createWindow();
  }).catch(error => {
    dialog.showErrorBox('Still could not start', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}