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
  moveFolder: (libraryId, from, to) => validId(libraryId) && typeof from === 'string' && typeof to === 'string' ? ipcRenderer.invoke('folder:move', libraryId, from, to) : Promise.reject(new Error('Invalid folder request.')),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen')
}));

contextBridge.exposeInMainWorld('desktopAuth', Object.freeze({
  status: () => ipcRenderer.invoke('auth:status'),
  login: (email, password) => ipcRenderer.invoke('auth:login', email, password),
  register: (email, password, displayName) => ipcRenderer.invoke('auth:register', email, password, displayName),
  logout: () => ipcRenderer.invoke('auth:logout'),
  updateProfile: displayName => ipcRenderer.invoke('auth:update-profile', displayName),
  sync: () => ipcRenderer.invoke('auth:sync'),
  continueLocal: () => ipcRenderer.invoke('auth:continue-local')
}));

contextBridge.exposeInMainWorld('wifiSync', Object.freeze({
  status: () => ipcRenderer.invoke('wifi-sync:status'),
  start: () => ipcRenderer.invoke('wifi-sync:start'),
  stop: () => ipcRenderer.invoke('wifi-sync:stop'),
  pair: () => ipcRenderer.invoke('wifi-sync:pair'),
  revoke: id => ipcRenderer.invoke('wifi-sync:revoke', id),
  retry: id => ipcRenderer.invoke('wifi-sync:retry', id),
  updateSettings: patch => ipcRenderer.invoke('wifi-sync:settings', patch),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('wifi-sync:event', listener);
    return () => ipcRenderer.removeListener('wifi-sync:event', listener);
  }
}));