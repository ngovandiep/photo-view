'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('./service.cjs');
const { createLibraryApi } = require('./library-api.cjs');

function register({ app, ipcMain, safeStorage, getWindow, manifestPath, readIndex, saveIndex, indexStore, getAccount, verifyLogin }) {
  const readManifestSync = () => {
    try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')).libraries || []; } catch { return []; }
  };
  const resolveLibrary = id => {
    const libraries = readManifestSync();
    const library = id ? libraries.find(item => item.id === id) : libraries[0];
    return library ? { id: library.id, root: library.path, name: library.name } : null;
  };
  const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };

  const emit = event => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('wifi-sync:event', event);
  };

  const { nativeImage } = require('electron');
  const dataDir = path.join(app.getPath('userData'), 'wifi-sync');
  const libraryApi = createLibraryApi({
    listLibraries: () => readManifestSync().map(item => ({ id: item.id, name: item.name })),
    resolveLibrary,
    readIndex,
    saveIndex,
    getAccount,
    verifyLogin,
    trashItem: file => require('electron').shell.trashItem(file),
    onChange: emit,
    appVersion: app.getVersion(),
    thumbDir: path.join(dataDir, 'thumbs'),
    makeThumbnail: (file, width) => {
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      return (size.width > width ? image.resize({ width, quality: 'good' }) : image).toJPEG(78);
    }
  });

  const service = createService({
    dataDir,
    resolveLibrary,
    libraryApi,
    listLibraries: () => readManifestSync().map(item => ({ id: item.id, name: item.name, path: item.path })),
    indexPhoto: async (libraryId, photo, hash) => {
      const index = await readIndex(libraryId);
      await saveIndex(libraryId, indexStore.addPhoto(index, photo, hash));
      emit({ type: 'library-changed', libraryId });
    },
    protect: canEncrypt() ? value => safeStorage.encryptString(value.toString('utf8')) : undefined,
    unprotect: canEncrypt() ? value => Buffer.from(safeStorage.decryptString(value), 'utf8') : undefined,
    emit
  });

  const safe = work => async (_event, ...args) => {
    try { return { ok: true, ...(await work(...args)) }; } catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('wifi-sync:status', safe(async () => ({ status: service.status() })));
  ipcMain.handle('wifi-sync:start', safe(async () => ({ status: await service.start() })));
  ipcMain.handle('wifi-sync:stop', safe(async () => ({ status: await service.stop() })));
  ipcMain.handle('wifi-sync:pair', safe(async () => ({ pairing: await service.createPairing() })));
  ipcMain.handle('wifi-sync:revoke', safe(async id => { await service.revokeDevice(String(id)); return { status: service.status() }; }));
  ipcMain.handle('wifi-sync:retry', safe(async id => { await service.retryAsset(String(id)); return { status: service.status() }; }));
  ipcMain.handle('wifi-sync:settings', safe(async patch => { service.updateSettings(patch && typeof patch === 'object' ? patch : {}); return { status: service.status() }; }));

  if (service.repo.getSettings().enabled) service.start().catch(() => {});
  // Keep recorded library paths valid when the user renames or moves a folder.
  app.on('library-folder-moved', (libraryId, from, to) => {
    try { service.repo.relocate(libraryId, from, to); } catch { /* sync history is best effort */ }
  });
  app.on('before-quit', () => { service.stop({ persist: false }).catch(() => {}); });
  return service;
}

module.exports = { register };
