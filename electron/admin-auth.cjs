'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';
const IDLE_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 60 * 1000;

const hash = (password, salt) => crypto.scryptSync(String(password), salt, 64);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Local admin account for the dashboard. Credentials are salted scrypt hashes in a file
// next to the app data; the plain password is never stored or logged.
function createAdminAuth({ file, now = Date.now }) {
  const sessions = new Map();
  let failures = 0;
  let lockedUntil = 0;

  function write(record) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  }
  function record(username, password, mustChange) {
    const salt = crypto.randomBytes(16);
    return { username, salt: salt.toString('hex'), hash: hash(password, salt).toString('hex'), mustChange };
  }
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && saved.username && saved.salt && saved.hash) return saved;
    } catch { /* first run or unreadable file: fall back to the default account */ }
    const created = record(DEFAULT_USERNAME, DEFAULT_PASSWORD, true);
    write(created);
    return created;
  }

  function login(sessionKey, username, password) {
    if (now() < lockedUntil) throw new Error(`Too many failed attempts. Try again in ${Math.ceil((lockedUntil - now()) / 1000)} seconds.`);
    const saved = read();
    const userOk = String(username || '').trim().toLowerCase() === saved.username.toLowerCase();
    const passOk = same(hash(password || '', Buffer.from(saved.salt, 'hex')), Buffer.from(saved.hash, 'hex'));
    if (!userOk || !passOk) {
      failures += 1;
      if (failures >= MAX_FAILURES) { failures = 0; lockedUntil = now() + LOCK_MS; }
      throw new Error('Invalid username or password.');
    }
    failures = 0;
    sessions.set(sessionKey, now() + IDLE_MS);
    return status(sessionKey);
  }

  function isUnlocked(sessionKey) {
    const expires = sessions.get(sessionKey);
    if (!expires) return false;
    if (expires < now()) { sessions.delete(sessionKey); return false; }
    sessions.set(sessionKey, now() + IDLE_MS);
    return true;
  }

  function status(sessionKey) {
    const saved = read();
    return { unlocked: isUnlocked(sessionKey), username: saved.username, mustChange: Boolean(saved.mustChange) };
  }

  function logout(sessionKey) { sessions.delete(sessionKey); }

  function change(sessionKey, { currentPassword, username, newPassword }) {
    if (!isUnlocked(sessionKey)) throw new Error('Admin sign-in required.');
    const saved = read();
    if (!same(hash(currentPassword || '', Buffer.from(saved.salt, 'hex')), Buffer.from(saved.hash, 'hex'))) throw new Error('Current password is incorrect.');
    const name = String(username || saved.username).trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) throw new Error('Username must be 3-32 letters, numbers, dots, dashes or underscores.');
    const next = String(newPassword || '');
    if (next.length < 8 || next.length > 200) throw new Error('New password must be 8-200 characters.');
    if (next === DEFAULT_PASSWORD) throw new Error('Choose a password other than the default.');
    write(record(name, next, false));
    // A credential change ends every other admin session.
    for (const key of [...sessions.keys()]) if (key !== sessionKey) sessions.delete(key);
    return status(sessionKey);
  }

  return { login, logout, status, isUnlocked, change, DEFAULT_USERNAME };
}

module.exports = { createAdminAuth, IDLE_MS, MAX_FAILURES, LOCK_MS };
