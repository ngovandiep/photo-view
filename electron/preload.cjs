'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function validId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

contextBridge.exposeInMainWorld('desktopLibrary', Object.freeze({
  listLibraries: () => ipcRenderer.invoke('library:list'),
  chooseFolders: () => ipcRenderer.invoke('library:choose-folders'),
  scanLibrary: (libraryId, onProgress) => {
    if (!validId(libraryId)) return Promise.reject(new Error('Invalid photo library identifier.'));
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const listener = (event, progress) => { if (progress.requestId === requestId && typeof onProgress === 'function') onProgress(progress); };
    ipcRenderer.on('library:progress', listener);
    return ipcRenderer.invoke('library:scan', libraryId, requestId).finally(() => ipcRenderer.removeListener('library:progress', listener));
  },
  loadIndex: libraryId => validId(libraryId) ? ipcRenderer.invoke('index:load', libraryId) : Promise.reject(new Error('Invalid photo library identifier.')),
  saveIndex: (libraryId, index) => validId(libraryId) ? ipcRenderer.invoke('index:save', libraryId, index) : Promise.reject(new Error('Invalid photo library identifier.')),
  backupIndex: libraryId => validId(libraryId) ? ipcRenderer.invoke('index:backup', libraryId) : Promise.reject(new Error('Invalid photo library identifier.')),
  backupLegacyMetadata: (libraryId, metadata) => validId(libraryId) ? ipcRenderer.invoke('index:backup-legacy', libraryId, metadata) : Promise.reject(new Error('Invalid photo library identifier.')),
  importIndex: libraryId => validId(libraryId) ? ipcRenderer.invoke('index:import', libraryId) : Promise.reject(new Error('Invalid photo library identifier.')),
  exportIndex: (libraryId, index) => validId(libraryId) ? ipcRenderer.invoke('index:export', libraryId, index) : Promise.reject(new Error('Invalid photo library identifier.')),
  readPhoto: (libraryId, relativePath) => validId(libraryId) && typeof relativePath === 'string' ? ipcRenderer.invoke('photo:read', libraryId, relativePath) : Promise.reject(new Error('Invalid photo request.')),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen')
}));