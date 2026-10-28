'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('./service.cjs');
const { createAdmin } = require('./admin.cjs');
const { createAdminAuth } = require('../admin-auth.cjs');
const { createLibraryApi } = require('./library-api.cjs');

function register({ app, ipcMain, safeStorage, getWindow, manifestPath, readIndex, saveIndex, indexStore, getAccount, verifyLogin, permit = null, listAccountUsers = null, setAccountUserDisabled, createAccountUser, setAccountUserRole, getChat = () => null, userChat = null }) {
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
    chat: userChat,
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
  // Starting, pairing, retrying and changing settings need the sync capability; status stays readable.
  const gate = work => async (...args) => {
    if (permit && !(await permit('sync'))) throw new Error('Your role is view-only and cannot manage Wi-Fi sync.');
    return work(...args);
  };
  ipcMain.handle('wifi-sync:start', safe(gate(async () => ({ status: await service.start() }))));
  ipcMain.handle('wifi-sync:stop', safe(gate(async () => ({ status: await service.stop() }))));
  ipcMain.handle('wifi-sync:pair', safe(gate(async () => ({ pairing: await service.createPairing() }))));
  ipcMain.handle('wifi-sync:revoke', safe(gate(async id => { await service.revokeDevice(String(id)); return { status: service.status() }; })));
  ipcMain.handle('wifi-sync:retry', safe(gate(async id => { await service.retryAsset(String(id)); return { status: service.status() }; })));
  ipcMain.handle('wifi-sync:settings', safe(gate(async patch => { service.updateSettings(patch && typeof patch === 'object' ? patch : {}); return { status: service.status() }; })));

  const admin = createAdmin({
    service,
    dataDir,
    listLibraries: () => readManifestSync().map(item => ({ id: item.id, name: item.name, path: item.path })),
    readIndex,
    getAccount,
    listAccountUsers
  });
  const filters = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const id = value => String(value || '').slice(0, 64);
  const adminAuth = createAdminAuth({ file: path.join(app.getPath('userData'), 'admin-credentials.json') });
  const sessionKey = event => event.sender.id;
  const audit = (kind, message, extra = {}) => { try { service.repo.logEvent({ category: 'security', kind, message, ...extra }); } catch { /* auditing must not block the action */ } };
  const open = (channel, work) => ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, ...(await work(event, ...args)) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  // Every dashboard channel requires an unlocked admin session for the calling window.
  const guarded = (channel, work) => ipcMain.handle(channel, async (event, ...args) => {
    if (!adminAuth.isUnlocked(sessionKey(event))) return { ok: false, locked: true, error: 'Admin sign-in required.' };
    try { return { ok: true, ...(await work(...args)) }; } catch (error) { return { ok: false, error: error.message }; }
  });

  open('admin:auth-status', event => ({ data: adminAuth.status(sessionKey(event)) }));
  open('admin:login', (event, username, password) => {
    try {
      const data = adminAuth.login(sessionKey(event), String(username || '').slice(0, 64), String(password || '').slice(0, 200));
      audit('admin_login', 'Administrator signed in.');
      return { data };
    } catch (error) {
      audit('admin_login_failed', 'Administrator sign-in failed.', { severity: 'warning', result: 'denied' });
      throw error;
    }
  });
  open('admin:logout', event => { adminAuth.logout(sessionKey(event)); return { data: adminAuth.status(sessionKey(event)) }; });
  open('admin:change-password', (event, input) => {
    const body = input && typeof input === 'object' ? input : {};
    const data = adminAuth.change(sessionKey(event), { currentPassword: String(body.currentPassword || ''), username: body.username, newPassword: String(body.newPassword || '') });
    audit('admin_credentials_changed', 'Administrator credentials were changed.');
    return { data };
  });

  guarded('admin:overview', async () => ({ data: await admin.overview() }));
  guarded('admin:wifi', async () => ({ data: await admin.wifi() }));
  guarded('admin:devices', async query => ({ data: admin.devices(filters(query)) }));
  guarded('admin:device', async deviceId => ({ data: admin.deviceDetail(id(deviceId)) }));
  guarded('admin:device-rename', async (deviceId, name) => ({ name: await service.renameDevice(id(deviceId), name) }));
  guarded('admin:device-revoke', async deviceId => { await service.revokeDevice(id(deviceId)); return {}; });
  guarded('admin:device-remove', async deviceId => { await service.removeDevice(id(deviceId)); return {}; });
  guarded('admin:sessions', async query => ({ data: admin.sessions(filters(query)) }));
  guarded('admin:session', async sessionId => ({ data: admin.sessionDetail(id(sessionId)) }));
  guarded('admin:session-retry', async sessionId => ({ data: await admin.retrySession(id(sessionId)) }));
  guarded('admin:sessions-csv', async query => ({ data: admin.sessionsCsv(filters(query)) }));
  guarded('admin:activity', async query => ({ data: admin.activity(filters(query)) }));
  guarded('admin:system', async () => ({ data: await admin.system() }));
  guarded('admin:users', async () => ({ data: await admin.users() }));
  guarded('admin:user-revoke', async userId => {
    const user = setAccountUserDisabled(Number(userId), true);
    audit('user_revoked', `Account ${user.email || user.id} was revoked by the administrator.`);
    return {};
  });
  guarded('admin:user-create', async input => {
    const body = input && typeof input === 'object' ? input : {};
    const user = createAccountUser({ email: String(body.email || '').slice(0, 320), displayName: String(body.displayName || '').slice(0, 100), password: String(body.password || '').slice(0, 200), role: body.role });
    audit('user_created', `Account ${user.email} was created by the administrator with role ${user.role}.`);
    return { data: user };
  });
  guarded('admin:user-role', async (userId, role) => {
    const user = setAccountUserRole(Number(userId), role);
    if (user.previous !== user.role) audit('user_role_changed', `Role of ${user.email || user.id} changed from ${user.previous} to ${user.role}.`);
    return { data: user };
  });
  guarded('admin:user-restore', async userId => {
    const user = setAccountUserDisabled(Number(userId), false);
    audit('user_restored', `Account ${user.email || user.id} was restored by the administrator.`);
    return {};
  });
  const chatOf = () => { const chat = getChat(); if (!chat) throw new Error('Chat is not available from this app.'); return chat; };
  const userId = value => { const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new Error('Invalid user.'); return n; };
  guarded('admin:chat-conversations', async status => ({ data: { conversations: chatOf().conversations({ status: status === 'closed' ? 'closed' : status === 'open' ? 'open' : undefined }), unread: chatOf().unreadForAdmin() } }));
  guarded('admin:chat-unread', async () => ({ data: { unread: getChat() ? getChat().unreadForAdmin() : 0 } }));
  guarded('admin:chat-thread', async (id, after) => { const chat = chatOf(); const data = chat.thread(userId(id), { after: Number(after) || 0 }); chat.markRead(userId(id), 'admin'); return { data }; });
  guarded('admin:chat-send', async (id, payload) => ({ data: chatOf().post(userId(id), 'admin', { body: String(payload?.text || ''), image: payload?.image }) }));
  guarded('admin:chat-status', async (id, status) => ({ data: chatOf().setStatus(userId(id), status) }));
  guarded('admin:chat-image', async (messageId, id) => { const image = chatOf().image(Number(messageId), userId(id)); if (!image) throw new Error('Image not found.'); return { data: `data:${image.type};base64,${image.data}` }; });
  guarded('admin:notify', async input => {
    const body = input && typeof input === 'object' ? input : {};
    const result = chatOf().notify({ title: String(body.title || ''), body: String(body.body || ''), userIds: Array.isArray(body.userIds) ? body.userIds.map(Number) : undefined });
    audit('notification_sent', `Notification sent to ${result.recipients} user(s).`);
    return { data: result };
  });
  guarded('admin:notifications-sent', async () => ({ data: chatOf().sentNotifications() }));  if (service.repo.getSettings().enabled) service.start().catch(() => {});
  // Keep recorded library paths valid when the user renames or moves a folder.
  app.on('library-folder-moved', (libraryId, from, to) => {
    try { service.repo.relocate(libraryId, from, to); } catch { /* sync history is best effort */ }
  });
  app.on('before-quit', () => { service.stop({ persist: false }).catch(() => {}); });
  return service;
}

module.exports = { register };
