'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db');
const { createApp } = require('../app');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]).toString('base64');

async function start() {
  const db = openDb(':memory:');
  const server = createApp(db, { secret: 's3cret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: ['Bearer', token].join(' ') } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json() };
  };
  const signUp = async email => (await call('POST', '/auth/register', { email, password: 'password1' })).json;
  return { db, server, base, call, signUp };
}

test('users chat with the admin, images are validated and read receipts work', async () => {
  const { server, call, signUp } = await start();
  try {
    const a = await signUp('a@x.com');
    const b = await signUp('b@x.com');
    assert.strictEqual((await call('POST', '/chat/messages', { body: 'hi' })).status, 401);
    assert.strictEqual((await call('POST', '/chat/messages', { body: '  ' }, a.token)).status, 400);
    const sent = await call('POST', '/chat/messages', { body: 'Hello admin', image: { type: 'image/png', data: PNG } }, a.token);
    assert.strictEqual(sent.status, 201);
    assert.strictEqual(sent.json.message.hasImage, true);
    assert.strictEqual((await call('POST', '/chat/messages', { image: { type: 'image/png', data: Buffer.from('not an image').toString('base64') } }, a.token)).status, 400);
    assert.strictEqual((await call('POST', '/chat/messages', { image: { type: 'text/html', data: PNG } }, a.token)).status, 400);

    const { chat } = server;
    assert.strictEqual(chat.conversations().length, 1);
    assert.strictEqual(chat.unreadForAdmin(), 1);
    chat.post(a.user.id, 'admin', { body: 'Welcome' });
    assert.strictEqual((await call('GET', '/chat/messages', null, a.token)).json.unread.messages, 1);
    const thread = (await call('GET', '/chat/messages', null, a.token)).json;
    assert.deepStrictEqual(thread.messages.map(m => m.sender), ['user', 'admin']);
    // Users never see each other's conversations or images.
    assert.strictEqual((await call('GET', '/chat/messages', null, b.token)).json.messages.length, 0);
    assert.strictEqual((await call('GET', `/chat/images/${sent.json.message.id}`, null, b.token)).status, 404);
    assert.strictEqual((await call('GET', `/chat/images/${sent.json.message.id}`, null, a.token)).json.type, 'image/png');

    await call('POST', '/chat/read', {}, a.token);
    assert.strictEqual((await call('GET', '/chat/messages', null, a.token)).json.unread.messages, 0);
    assert.ok(chat.thread(a.user.id).messages.find(m => m.sender === 'admin').readAt);
    chat.markRead(a.user.id, 'admin');
    assert.strictEqual(chat.unreadForAdmin(), 0);
    assert.strictEqual((await call('GET', `/chat/messages?after=${thread.messages[0].id}`, null, a.token)).json.messages.length, 1);
  } finally { server.close(); }
});

test('closing a conversation hides it from open and a new message reopens it', async () => {
  const { server, call, signUp } = await start();
  try {
    const a = await signUp('a@x.com');
    const { chat } = server;
    chat.post(a.user.id, 'user', { body: 'help' });
    chat.setStatus(a.user.id, 'closed');
    assert.strictEqual(chat.conversations({ status: 'open' }).length, 0);
    assert.strictEqual(chat.unreadForAdmin(), 0);
    assert.strictEqual((await call('POST', '/chat/messages', { body: 'again' }, a.token)).status, 201);
    assert.strictEqual(chat.conversations({ status: 'open' }).length, 1);
    assert.throws(() => chat.setStatus(a.user.id, 'weird'), /open or closed/);
  } finally { server.close(); }
});

test('notifications go to everyone or selected users and track read state', async () => {
  const { db, server, call, signUp } = await start();
  try {
    const a = await signUp('a@x.com');
    const b = await signUp('b@x.com');
    const c = await signUp('c@x.com');
    db.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(c.user.id);
    const { chat } = server;
    assert.strictEqual(chat.notify({ title: 'Maintenance', body: 'Tonight' }).recipients, 2);
    assert.strictEqual(chat.notify({ title: 'Just you', userIds: [a.user.id] }).recipients, 1);
    assert.throws(() => chat.notify({ title: '', body: 'x' }), /title/);
    assert.throws(() => chat.notify({ title: 'x', userIds: [] }), /at least one/);
    const mine = (await call('GET', '/chat/notifications', null, a.token)).json;
    assert.strictEqual(mine.notifications.length, 2);
    assert.strictEqual(mine.unread.notifications, 2);
    assert.strictEqual((await call('GET', '/chat/notifications', null, b.token)).json.notifications.length, 1);
    await call('POST', '/chat/notifications/read', { ids: [mine.notifications[0].id] }, a.token);
    assert.strictEqual((await call('GET', '/chat/notifications', null, a.token)).json.unread.notifications, 1);
    await call('POST', '/chat/notifications/read', {}, a.token);
    assert.strictEqual((await call('GET', '/chat/notifications', null, a.token)).json.unread.notifications, 0);
    assert.strictEqual(chat.sentNotifications()[0].audience, 'selected');
  } finally { server.close(); }
});

test('live stream pushes admin messages to the user and old history is purged', async () => {
  const { db, server, base, signUp } = await start();
  try {
    const a = await signUp('a@x.com');
    const controller = new AbortController();
    const res = await fetch(`${base}/chat/stream`, { headers: { Authorization: ['Bearer', a.token].join(' ') }, signal: controller.signal });
    assert.strictEqual(res.status, 200);
    const reader = res.body.getReader();
    let seen = '';
    const read = async until => { const decoder = new TextDecoder(); while (!seen.includes(until)) { const { value, done } = await reader.read(); if (done) break; seen += decoder.decode(value); } };
    await read('"ready"');
    server.chat.post(a.user.id, 'admin', { body: 'ping' });
    await read('"message"');
    assert.ok(seen.includes('"preview":"ping"'));
    controller.abort();

    server.chat.post(a.user.id, 'user', { body: 'old' });
    db.prepare("UPDATE messages SET created_at = datetime('now', '-100 days')").run();
    server.chat.notify({ title: 'old news' });
    db.prepare("UPDATE notifications SET created_at = datetime('now', '-100 days')").run();
    const purged = server.chat.purge(90);
    assert.ok(purged.messages >= 2 && purged.notifications === 1);
    assert.strictEqual(server.chat.conversations().length, 0);
  } finally { server.closeAllConnections(); server.close(); }
});
