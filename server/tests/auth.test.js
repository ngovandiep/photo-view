'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db');
const { createApp } = require('../app');
const { signJwt, verifyJwt } = require('../auth');

async function start(options) {
  const server = createApp(openDb(':memory:'), { secret: 's3cret', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json() };
  };
  return { server, call };
}

test('register, login, and fetch the current user', async () => {
  const { server, call } = await start();
  try {
    const reg = await call('/auth/register', { email: 'A@x.com', password: 'password1' });
    assert.strictEqual(reg.status, 201);
    assert.strictEqual(reg.json.user.email, 'a@x.com');
    assert.strictEqual((await call('/auth/register', { email: 'a@x.com', password: 'password1' })).status, 409);
    const login = await call('/auth/login', { email: 'a@x.com', password: 'password1' });
    assert.strictEqual(login.status, 200);
    const me = await call('/auth/me', null, login.json.token);
    assert.strictEqual(me.json.user.email, 'a@x.com');
    assert.ok(!JSON.stringify(me.json).includes('password'));
  } finally { server.close(); }
});

test('rejects wrong password, unknown email, short password, and bad tokens', async () => {
  const { server, call } = await start();
  try {
    await call('/auth/register', { email: 'a@x.com', password: 'password1' });
    assert.strictEqual((await call('/auth/login', { email: 'a@x.com', password: 'wrong-pass' })).status, 401);
    assert.strictEqual((await call('/auth/login', { email: 'no@x.com', password: 'password1' })).status, 401);
    assert.strictEqual((await call('/auth/register', { email: 'b@x.com', password: 'short' })).status, 400);
    assert.strictEqual((await call('/auth/me')).status, 401);
    assert.strictEqual((await call('/auth/me', null, signJwt({ sub: '1' }, 'other-secret', 60))).status, 401);
  } finally { server.close(); }
});

test('profile update and per-user annotation sync', async () => {
  const { server, call } = await start();
  const put = async (path, body, token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    const a = (await call('/auth/register', { email: 'a@x.com', password: 'password1' })).json.token;
    const b = (await call('/auth/register', { email: 'b@x.com', password: 'password1' })).json.token;
    assert.strictEqual((await put('/auth/me', { displayName: 'Alice' }, a)).json.user.displayName, 'Alice');
    assert.strictEqual((await put('/auth/me', { displayName: ' ' }, a)).status, 400);
    const data = { albums: [], entries: [{ path: 'x.jpg', favorite: true, tags: [], albumIds: [] }] };
    assert.strictEqual((await put('/sync/annotations', { library: 'Photos', data }, a)).status, 200);
    assert.strictEqual((await call('/sync/annotations?library=Photos', null, a)).json.data.entries.length, 1);
    assert.strictEqual((await call('/sync/annotations?library=Photos', null, b)).json.data, null);
    assert.strictEqual((await put('/sync/annotations', { library: 'Photos', data: {} }, a)).status, 400);
    assert.strictEqual((await put('/sync/annotations', { library: 'Photos', data }, 'bad')).status, 401);
  } finally { server.close(); }
});

test('rate limits repeated attempts', async () => {
  const { server, call } = await start({ maxAttempts: 3 });
  try {
    for (let i = 0; i < 3; i += 1) { await call('/auth/login', { email: 'a@x.com', password: 'wrong-pass' }); }
    assert.strictEqual((await call('/auth/login', { email: 'a@x.com', password: 'wrong-pass' })).status, 429);
  } finally { server.close(); }
});

test('jwt rejects expired tokens and alg tampering', () => {
  assert.strictEqual(verifyJwt(signJwt({ sub: '1' }, 's', -10), 's'), null);
  const good = signJwt({ sub: '1' }, 's', 60);
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  assert.strictEqual(verifyJwt(`${none}.${good.split('.')[1]}.`, 's'), null);
  assert.strictEqual(verifyJwt(good, 's').sub, '1');
});
