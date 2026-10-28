'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { extractAnnotations, mergeAnnotations } = require('./sync.cjs');
const { normalizeRole, permissionsFor } = require('./permissions.cjs');

const DEFAULT_API_URL = 'http://127.0.0.1:3000';

function normalizeApiUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('The API URL must use https (http is allowed only for localhost).');
  return url.origin;
}

function register({ app, ipcMain, safeStorage, libraries }) {
  const file = () => path.join(app.getPath('userData'), 'auth.json');
  let state = { token: '', user: null, localOnly: false };
  let loaded = false;

  const apiUrl = () => normalizeApiUrl(process.env.STILL_API_URL || DEFAULT_API_URL);

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await fs.readFile(file(), 'utf8'));
      const token = saved.token && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.token, 'base64')) : '';
      state = { token, user: token ? saved.user || null : null, localOnly: saved.localOnly === true };
    } catch { /* first run or unreadable file: start signed out */ }
  }

  async function persist() {
    const token = state.token && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(state.token).toString('base64') : '';
    await fs.writeFile(file(), JSON.stringify({ token, user: token ? state.user : null, localOnly: state.localOnly }), { mode: 0o600 });
  }

  async function request(method, endpoint, body, token) {
    let response;
    try {
      response = await fetch(apiUrl() + endpoint, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      throw Object.assign(new Error(`Cannot reach the account server at ${apiUrl()}. Is it running?`), { network: true });
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof json.error === 'string' ? json.error : 'Request failed.'), { status: response.status });
    return json;
  }

  const currentRole = () => (state.token && state.user ? normalizeRole(state.user.role) : 'viewer');
  const tokenListeners = new Set();
  let announcedToken = '';
  // Lets other modules (chat) start or stop work when the session token appears, changes or goes away.
  const announceToken = () => { if (state.token === announcedToken) return; announcedToken = state.token; for (const listener of tokenListeners) { try { listener(state.token); } catch { /* listener errors must not break sign-in */ } } };
  const publicState = () => { announceToken(); return { signedIn: !!state.token, user: state.user, localOnly: state.localOnly, role: currentRole(), permissions: permissionsFor(currentRole()) }; };
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

  const credentialsFile = () => path.join(app.getPath('userData'), 'saved-login.bin');
  async function readCredentials() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const saved = JSON.parse(safeStorage.decryptString(await fs.readFile(credentialsFile())));
      return typeof saved.email === 'string' && typeof saved.password === 'string' ? { email: saved.email, password: saved.password } : null;
    } catch { return null; }
  }
  async function saveCredentials(credentials) {
    if (!credentials || !safeStorage.isEncryptionAvailable()) { await fs.rm(credentialsFile(), { force: true }); return; }
    await fs.writeFile(credentialsFile(), safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
  }

  async function signIn(endpoint, body) {
    const result = await request('POST', endpoint, body);
    state = { token: result.token, user: result.user, localOnly: false };
    await persist();
    return publicState();
  }

  ipcMain.handle('auth:status', async () => {
    await load();
    if (state.token) {
      try {
        state.user = (await request('GET', '/auth/me', null, state.token)).user;
        await persist();
      } catch (error) {
        if (error.status === 401) { state = { token: '', user: null, localOnly: false }; await persist(); }
      }
    }
    return publicState();
  });
  ipcMain.handle('auth:login', async (_event, email, password, remember) => {
    await load();
    const result = await signIn('/auth/login', { email: text(email, 320), password: text(password, 200) });
    await saveCredentials(remember === true ? { email: text(email, 320), password: text(password, 200) } : null);
    return result;
  });
  ipcMain.handle('auth:saved-credentials', async () => { await load(); return readCredentials(); });
  ipcMain.handle('auth:register', async (_event, email, password, displayName) => {
    await load();
    return signIn('/auth/register', { email: text(email, 320), password: text(password, 200), displayName: text(displayName, 100) });
  });
  ipcMain.handle('auth:logout', async () => { await load(); state = { token: '', user: null, localOnly: false }; await persist(); return publicState(); });
  ipcMain.handle('auth:continue-local', async () => { await load(); state.localOnly = true; await persist(); return publicState(); });
  const getUser = async () => { await load(); return state.token ? state.user : null; };

  // The role is re-read from the account server so a demotion or revoke takes effect within seconds.
  let roleCheckedAt = 0;
  const getRole = async () => {
    await load();
    if (!state.token) return 'viewer';
    if (Date.now() - roleCheckedAt > 10000) {
      try {
        state.user = (await request('GET', '/auth/me', null, state.token)).user;
        roleCheckedAt = Date.now();
        await persist();
      } catch (error) {
        if (error.status === 401 || error.status === 403) return 'viewer';
      }
    }
    return currentRole();
  };

  ipcMain.handle('auth:update-profile', async (_event, displayName) => {
    await load();
    if (!state.token) throw new Error('Sign in first.');
    state.user = (await request('PUT', '/auth/me', { displayName: text(displayName, 100) }, state.token)).user;
    await persist();
    return publicState();
  });

  // Pulls remote annotations into each local index (additive), then pushes the merged result back.
  ipcMain.handle('auth:sync', async () => {
    await load();
    if (!state.token) throw new Error('Sign in first.');
    const summary = { libraries: 0, merged: 0, pushed: 0 };
    try {
      for (const library of await libraries.list()) {
        let index = await libraries.read(library.id);
        const remote = await request('GET', `/sync/annotations?library=${encodeURIComponent(library.name)}`, null, state.token);
        if (remote.data) {
          const result = mergeAnnotations(index, remote.data);
          if (result.changed || result.index.albums.length !== index.albums.length) await libraries.save(library.id, result.index);
          index = result.index;
          summary.merged += result.changed;
        }
        const data = extractAnnotations(index);
        await request('PUT', '/sync/annotations', { library: library.name, data }, state.token);
        summary.libraries += 1;
        summary.pushed += data.entries.length;
      }
    } catch (error) {
      if (error.status === 401) { state = { token: '', user: null, localOnly: false }; await persist(); throw new Error('Your session expired. Please sign in again.'); }
      throw error;
    }
    return summary;
  });
  // Checks credentials against the account server without touching the desktop's own session.
  const verifyLogin = async (email, password) => (await request('POST', '/auth/login', { email: text(email, 320), password: text(password, 200) })).user;
  const chatContext = {
    apiUrl,
    token: () => state.token,
    userId: () => (state.token && state.user ? state.user.id : null),
    request: (method, endpoint, body) => request(method, endpoint, body, state.token),
    onToken: listener => { tokenListeners.add(listener); if (state.token) listener(state.token); return () => tokenListeners.delete(listener); }
  };
  return { getUser, verifyLogin, getRole, chatContext };
}

module.exports = { register, normalizeApiUrl };
