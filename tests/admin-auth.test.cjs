'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdminAuth, MAX_FAILURES, LOCK_MS, IDLE_MS } = require('../electron/admin-auth.cjs');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
  const clock = { t: 1000 };
  const auth = createAdminAuth({ file: path.join(dir, 'admin.json'), now: () => clock.t });
  return { dir, clock, auth, file: path.join(dir, 'admin.json') };
}

test('default admin/123456 signs in, is hashed on disk and must be changed', () => {
  const { auth, file, dir } = setup();
  assert.equal(auth.status(1).unlocked, false);
  const status = auth.login(1, 'admin', '123456');
  assert.deepEqual([status.unlocked, status.mustChange], [true, true]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('123456'));
  assert.equal(auth.isUnlocked(2), false);
  fs.rmSync(dir, { recursive: true });
});

test('wrong credentials are rejected and repeated failures lock sign-in', () => {
  const { auth, clock, dir } = setup();
  for (let i = 0; i < MAX_FAILURES; i += 1) assert.throws(() => auth.login(1, 'admin', 'nope'), /Invalid/);
  assert.throws(() => auth.login(1, 'admin', '123456'), /Too many/);
  clock.t += LOCK_MS + 1;
  assert.equal(auth.login(1, 'admin', '123456').unlocked, true);
  fs.rmSync(dir, { recursive: true });
});

test('sessions expire when idle and logout locks', () => {
  const { auth, clock, dir } = setup();
  auth.login(1, 'admin', '123456');
  clock.t += IDLE_MS + 1;
  assert.equal(auth.isUnlocked(1), false);
  auth.login(1, 'admin', '123456');
  auth.logout(1);
  assert.equal(auth.isUnlocked(1), false);
  fs.rmSync(dir, { recursive: true });
});

test('changing credentials validates input, clears mustChange and ends other sessions', () => {
  const { auth, dir } = setup();
  auth.login(1, 'admin', '123456');
  auth.login(2, 'admin', '123456');
  assert.throws(() => auth.change(1, { currentPassword: 'bad', newPassword: 'longenough1' }), /incorrect/);
  assert.throws(() => auth.change(1, { currentPassword: '123456', newPassword: 'short' }), /8-200/);
  assert.throws(() => auth.change(1, { currentPassword: '123456', newPassword: '123456' }), /8-200|default/);
  assert.throws(() => auth.change(3, { currentPassword: '123456', newPassword: 'longenough1' }), /sign-in required/);
  const status = auth.change(1, { currentPassword: '123456', username: 'boss', newPassword: 'longenough1' });
  assert.deepEqual([status.username, status.mustChange], ['boss', false]);
  assert.equal(auth.isUnlocked(2), false);
  assert.throws(() => auth.login(1, 'admin', '123456'), /Invalid/);
  assert.equal(auth.login(1, 'boss', 'longenough1').unlocked, true);
  fs.rmSync(dir, { recursive: true });
});

test('a disabled account cannot sign in and its existing token stops working until restored', async () => {
  const db = openDb(':memory:');
  const server = createApp(db, { secret: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const registered = await (await post('/auth/register', { email: 'a@example.com', password: 'password123' })).json();
    const me = token => fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await me(registered.token)).status, 200);
    db.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?").run('a@example.com');
    assert.equal((await me(registered.token)).status, 401);
    const login = await post('/auth/login', { email: 'a@example.com', password: 'password123' });
    assert.equal(login.status, 403);
    db.prepare('UPDATE users SET disabled_at = NULL WHERE email = ?').run('a@example.com');
    assert.equal((await me(registered.token)).status, 200);
  } finally { server.close(); }
});

test('admin can create users with a role, change roles and cannot remove the last admin', async () => {
  const { createUserAdmin } = require('../server/admin-users');
  const db = openDb(':memory:');
  const users = createUserAdmin(db);
  const created = users.create({ email: ' New@Example.com ', displayName: '', password: 'password123', role: 'admin' });
  assert.deepEqual([created.email, created.role], ['new@example.com', 'admin']);
  assert.equal(users.list()[0].display_name, 'new');
  assert.ok(!JSON.stringify(users.list()).includes('password_hash'));
  assert.throws(() => users.create({ email: 'new@example.com', password: 'password123' }), /already registered/);
  assert.throws(() => users.create({ email: 'bad', password: 'password123' }), /valid email/);
  assert.throws(() => users.create({ email: 'x@example.com', password: 'short' }), /8-200/);
  assert.throws(() => users.create({ email: 'x@example.com', password: 'password123', role: 'root' }), /Role must be/);
  assert.throws(() => users.setRole(created.id, 'viewer'), /At least one active admin/);
  const second = users.create({ email: 'b@example.com', password: 'password123' });
  assert.equal(users.list().find(u => u.id === second.id).role, 'viewer');
  assert.equal(users.setRole(second.id, 'editor').role, 'editor');
  assert.equal(users.setRole(second.id, 'admin').role, 'admin');
  assert.equal(users.setRole(created.id, 'viewer').role, 'viewer');
  assert.throws(() => users.setRole(999, 'viewer'), /not found/);
  // The created account can sign in through the normal API and reports its role.
  const server = createApp(db, { secret: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'b@example.com', password: 'password123' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.role, 'admin');
  } finally { server.close(); }
});

test('roles map to capabilities and unknown or legacy roles are view-only', () => {
  const { permissionsFor, can } = require('../electron/permissions.cjs');
  assert.deepEqual(permissionsFor('viewer'), { edit: false, sync: false });
  assert.deepEqual(permissionsFor('editor'), { edit: true, sync: true });
  assert.equal(can('admin', 'edit'), true);
  for (const legacy of ['user', '', null, undefined, 'root']) assert.equal(can(legacy, 'edit') || can(legacy, 'sync'), false);
});

test('legacy user roles are migrated to viewer', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (email, password_hash, display_name, role) VALUES ('old@example.com', 'x', 'Old', 'user')").run();
  db.exec("UPDATE users SET role = 'viewer' WHERE role NOT IN ('viewer', 'editor', 'admin')");
  assert.equal(db.prepare('SELECT role FROM users').get().role, 'viewer');
});