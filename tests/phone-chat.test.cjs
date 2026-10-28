'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const chatClient = require('../electron/chat-client.cjs');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createLibraryApi } = require('../electron/wifi-sync/library-api.cjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3)]);
const bearer = token => ['Bearer', token].join(' ');

// Real account server + real desktop chat client + real Wi-Fi sync server; only Electron windows are faked.
async function harness({ phoneLogin = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-chat-'));
  const accounts = createApp(openDb(':memory:'), { secret: 'test-secret' });
  await new Promise(resolve => accounts.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${accounts.address().port}`;
  const registered = await (await fetch(`${apiBase}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pat@x.com', password: 'password1' }) })).json();

  let token = registered.token;
  let account = registered.user;
  const tokenListeners = new Set();
  const auth = {
    apiUrl: () => apiBase,
    token: () => token,
    request: async (method, endpoint, body) => {
      const response = await fetch(apiBase + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: bearer(token) } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(json.error || 'Request failed.'), { status: response.status });
      return json;
    },
    onToken: listener => { tokenListeners.add(listener); if (token) listener(token); return () => tokenListeners.delete(listener); }
  };
  const chat = chatClient.register({ ipcMain: { handle() {} }, auth, BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } });

  const library = { id: 'c'.repeat(64), root: path.join(root, 'photos'), name: 'photos' };
  await fs.mkdir(library.root, { recursive: true });
  const libraryApi = createLibraryApi({
    listLibraries: () => [library], resolveLibrary: () => library, readIndex: async () => ({ photos: [] }), saveIndex: async () => {},
    makeThumbnail: () => null, thumbDir: path.join(root, 'thumbs'),
    getAccount: async () => (token ? account : null),
    verifyLogin: async (email, password) => (password === 'password1' ? { email } : null),
    chat
  });
  const service = createService({ dataDir: path.join(root, 'data'), resolveLibrary: () => library, listLibraries: () => [library], indexPhoto: async () => {}, libraryApi, tls: false, host: '127.0.0.1' });
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id, minFreeSpaceMB: 0 });
  await service.start();
  const base = `${service.status().url}/api/v1`;
  const { code } = await service.createPairing();
  const claim = await (await fetch(`${base}/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Phone', platform: 'web' }) })).json();
  const phone = {
    get: route => fetch(base + route, { headers: { Authorization: bearer(claim.token) } }),
    post: (route, body) => fetch(base + route, { method: 'POST', headers: { Authorization: bearer(claim.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    // Collects SSE events until `until(event)` matches.
    async stream() {
      const controller = new AbortController();
      const response = await fetch(`${base}/chat/stream`, { headers: { Authorization: bearer(claim.token) }, signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events = [];
      let ended = false;
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
              if (frame.startsWith('data:')) events.push(JSON.parse(frame.slice(5)));
            }
          }
        } catch { /* aborted */ }
        ended = true;
      })();
      const waitFor = async (match, ms = 4000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { const found = events.find(match); if (found) return found; if (ended) break; await new Promise(r => setTimeout(r, 20)); }
        throw new Error(`event not received; got ${JSON.stringify(events)}`);
      };
      return { status: response.status, events, waitFor, isEnded: () => ended, done: pump, close: () => controller.abort() };
    }
  };
  if (phoneLogin) assert.equal((await phone.post('/login', { email: 'pat@x.com', password: 'password1' })).status, 200);
  // Wait until the desktop client's own live connection to the account server is up.
  for (let i = 0; i < 100 && !(accounts.chat && chat.signedIn()); i += 1) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 150));
  return {
    phone, chat, server: accounts.chat, userId: account.id,
    signOutDesktop() { token = ''; account = null; for (const listener of tokenListeners) listener(''); },
    async close() { chat.close(); await service.stop(); service.close(); accounts.closeAllConnections(); accounts.close(); await fs.rm(root, { recursive: true, force: true }); }
  };
}

test('phone chat needs a phone signed in to the computer account', async () => {
  const h = await harness({ phoneLogin: false });
  try {
    const me = await (await h.phone.get('/me')).json();
    assert.equal(me.chat, false);
    const blocked = await h.phone.get('/chat/messages');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'login_required');
    assert.equal((await h.phone.post('/login', { email: 'pat@x.com', password: 'password1' })).status, 200);
    assert.equal((await (await h.phone.get('/me')).json()).chat, true);
    assert.equal((await h.phone.get('/chat/messages')).status, 200);
  } finally { await h.close(); }
});

test('phone sends text and photos to the admin and reads replies', async () => {
  const h = await harness();
  try {
    const sent = await h.phone.post('/chat/messages', { text: 'Hi from my phone' });
    assert.equal(sent.status, 201);
    const photo = await h.phone.post('/chat/messages', { text: '', image: { type: 'image/png', data: PNG.toString('base64') } });
    assert.equal(photo.status, 201);
    const photoId = (await photo.json()).message.id;
    assert.equal((await h.phone.post('/chat/messages', { image: { type: 'text/html', data: PNG.toString('base64') } })).status, 400);
    assert.equal((await h.phone.post('/chat/messages', { text: '   ' })).status, 400);

    const convo = h.server.conversations()[0];
    assert.equal(convo.userId, h.userId);
    assert.equal(convo.unread, 2);

    const image = await h.phone.get(`/chat/images/${photoId}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
    assert.equal((await h.phone.get('/chat/images/999999')).status, 404);

    h.server.post(h.userId, 'admin', { body: 'Got it!' });
    const thread = await (await h.phone.get('/chat/messages')).json();
    assert.deepEqual(thread.messages.map(m => m.sender), ['user', 'user', 'admin']);
    assert.equal(thread.unread.messages, 1);
  } finally { await h.close(); }
});

test('phone receives admin messages and notifications live, and reading syncs every device', async () => {
  const h = await harness();
  try {
    const live = await h.phone.stream();
    assert.equal(live.status, 200);
    await live.waitFor(e => e.type === 'unread');

    h.server.post(h.userId, 'admin', { body: 'Are you there?' });
    const message = await live.waitFor(e => e.type === 'message' && e.sender === 'admin');
    assert.equal(message.preview, 'Are you there?');
    await live.waitFor(e => e.type === 'unread' && e.unread.messages === 1);
    assert.equal(h.chat.status().unread.messages, 1, 'desktop badge counts the same message');

    // Reading on the phone clears the badge on the desktop too.
    assert.equal((await h.phone.post('/chat/read')).status, 200);
    await live.waitFor(e => e.type === 'unread' && e.unread.messages === 0 && e !== live.events.find(x => x.type === 'unread'));
    for (let i = 0; i < 50 && h.chat.status().unread.messages; i += 1) await new Promise(r => setTimeout(r, 20));
    assert.equal(h.chat.status().unread.messages, 0);

    h.server.notify({ title: 'Maintenance', body: 'Tonight at 10' });
    const note = await live.waitFor(e => e.type === 'notification');
    assert.equal(note.title, 'Maintenance');
    await live.waitFor(e => e.type === 'unread' && e.unread.notifications === 1);
    const list = await (await h.phone.get('/chat/notifications')).json();
    assert.equal(list.notifications[0].title, 'Maintenance');
    await h.phone.post('/chat/notifications/read', {});
    await live.waitFor(e => e.type === 'unread' && e.unread.notifications === 0);

    // A message sent from the phone also reaches the user's other screens (desktop panel).
    await h.phone.post('/chat/messages', { text: 'From phone' });
    await live.waitFor(e => e.type === 'message' && e.sender === 'user');
    // Events never carry the account token.
    assert.ok(!JSON.stringify(live.events).includes('token'));
    live.close();
  } finally { await h.close(); }
});

test('signing out on the computer ends phone chat', async () => {
  const h = await harness();
  try {
    const live = await h.phone.stream();
    await live.waitFor(e => e.type === 'unread');
    h.signOutDesktop();
    await live.done;
    assert.equal(live.isEnded(), true);
    const after = await h.phone.get('/chat/status');
    assert.equal(after.status, 409);
    assert.equal((await after.json()).error.code, 'chat_unavailable');
    assert.equal((await (await h.phone.get('/me')).json()).chat, false);
  } finally { await h.close(); }
});
