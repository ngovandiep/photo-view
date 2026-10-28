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
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: ui => ipcRenderer.invoke('session:save', ui && typeof ui === 'object' ? ui : {}),
  cachedScan: libraryId => validId(libraryId) ? ipcRenderer.invoke('library:cached-scan', libraryId) : Promise.reject(new Error('Invalid photo library identifier.')),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen')
}));

contextBridge.exposeInMainWorld('desktopAuth', Object.freeze({
  status: () => ipcRenderer.invoke('auth:status'),
  login: (email, password, remember) => ipcRenderer.invoke('auth:login', email, password, remember),
  savedCredentials: () => ipcRenderer.invoke('auth:saved-credentials'),
  register: (email, password, displayName) => ipcRenderer.invoke('auth:register', email, password, displayName),
  logout: () => ipcRenderer.invoke('auth:logout'),
  updateProfile: displayName => ipcRenderer.invoke('auth:update-profile', displayName),
  sync: () => ipcRenderer.invoke('auth:sync'),
  continueLocal: () => ipcRenderer.invoke('auth:continue-local')
}));

contextBridge.exposeInMainWorld('adminApi', Object.freeze({
  overview: () => ipcRenderer.invoke('admin:overview'),
  wifi: () => ipcRenderer.invoke('admin:wifi'),
  devices: query => ipcRenderer.invoke('admin:devices', query),
  device: id => ipcRenderer.invoke('admin:device', id),
  renameDevice: (id, name) => ipcRenderer.invoke('admin:device-rename', id, name),
  removeDevice: id => ipcRenderer.invoke('admin:device-remove', id),
  sessions: query => ipcRenderer.invoke('admin:sessions', query),
  session: id => ipcRenderer.invoke('admin:session', id),
  retrySession: id => ipcRenderer.invoke('admin:session-retry', id),
  sessionsCsv: query => ipcRenderer.invoke('admin:sessions-csv', query),
  activity: query => ipcRenderer.invoke('admin:activity', query),
  system: () => ipcRenderer.invoke('admin:system'),
  users: () => ipcRenderer.invoke('admin:users'),
  authStatus: () => ipcRenderer.invoke('admin:auth-status'),
  login: (username, password) => ipcRenderer.invoke('admin:login', username, password),
  logout: () => ipcRenderer.invoke('admin:logout'),
  changePassword: input => ipcRenderer.invoke('admin:change-password', input),
  revokeDevice: id => ipcRenderer.invoke('admin:device-revoke', id),
  revokeUser: id => ipcRenderer.invoke('admin:user-revoke', id),
  restoreUser: id => ipcRenderer.invoke('admin:user-restore', id),
  createUser: input => ipcRenderer.invoke('admin:user-create', input),
  setUserRole: (id, role) => ipcRenderer.invoke('admin:user-role', id, role),
  chatConversations: status => ipcRenderer.invoke('admin:chat-conversations', status),
  chatUnread: () => ipcRenderer.invoke('admin:chat-unread'),
  chatThread: (id, after) => ipcRenderer.invoke('admin:chat-thread', id, after),
  chatSend: (id, payload) => ipcRenderer.invoke('admin:chat-send', id, payload),
  chatSetStatus: (id, status) => ipcRenderer.invoke('admin:chat-status', id, status),
  chatImage: (messageId, id) => ipcRenderer.invoke('admin:chat-image', messageId, id),
  notify: input => ipcRenderer.invoke('admin:notify', input),
  sentNotifications: () => ipcRenderer.invoke('admin:notifications-sent'),
  onChatEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('admin:chat-event', listener);
    return () => ipcRenderer.removeListener('admin:chat-event', listener);
  }
}));

contextBridge.exposeInMainWorld('desktopChat', Object.freeze({
  status: () => ipcRenderer.invoke('chat:status'),
  messages: after => ipcRenderer.invoke('chat:messages', after),
  send: (text, image) => ipcRenderer.invoke('chat:send', { text, image }),
  markRead: () => ipcRenderer.invoke('chat:read'),
  image: id => ipcRenderer.invoke('chat:image', id),
  notifications: () => ipcRenderer.invoke('chat:notifications'),
  readNotifications: ids => ipcRenderer.invoke('chat:notifications-read', ids),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  }
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