'use strict';
const http = require('node:http');
const { normalizeRole } = require('./roles');
const { createChat } = require('./chat');
const { hashPassword, verifyPassword, signJwt, verifyJwt } = require('./auth');

const TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const MAX_BODY = 10 * 1024;
const MAX_SYNC_BODY = 20 * 1024 * 1024;
const MAX_CHAT_BODY = 3 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = hashPassword('dummy-password');

function createApp(db, { secret, maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) {
  if (!secret) { throw new Error('A JWT secret is required.'); }
  const attempts = new Map();
  const chat = createChat(db);
  const streams = new Map();
  chat.hub.on('user', (userId, event) => {
    for (const res of streams.get(userId) || []) res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
    });
    res.end(JSON.stringify(body));
  };

  const readJson = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });

  const limited = key => {
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter(t => now - t < windowMs);
    attempts.set(key, recent);
    return recent.length >= maxAttempts;
  };
  const recordAttempt = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

  const publicUser = row => ({ id: row.id, email: row.email, displayName: row.display_name, role: normalizeRole(row.role) });
  const issue = row => ({ token: signJwt({ sub: String(row.id) }, secret, TOKEN_TTL_SECONDS), user: publicUser(row) });

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { return send(res, 204, {}); }

    if (req.method === 'POST' && (pathname === '/auth/register' || pathname === '/auth/login')) {
      const key = req.socket.remoteAddress || 'unknown';
      if (limited(key)) { return send(res, 429, { error: 'Too many attempts. Try again later.' }); }
      recordAttempt(key);
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!EMAIL_RE.test(email) || email.length > 320) { return send(res, 400, { error: 'A valid email is required.' }); }

      if (pathname === '/auth/register') {
        if (password.length < 8 || password.length > 200) { return send(res, 400, { error: 'Password must be 8-200 characters.' }); }
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) { return send(res, 409, { error: 'Email is already registered.' }); }
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '';
        const id = Number(db.prepare('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)')
          .run(email, hashPassword(password), displayName || email.split('@')[0]).lastInsertRowid);
        return send(res, 201, issue(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
      }

      const row = db.prepare('SELECT * FROM users WHERE email = ? AND password_hash IS NOT NULL').get(email);
      const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) { return send(res, 401, { error: 'Invalid email or password.' }); }
      if (row.disabled_at) { return send(res, 403, { error: 'This account has been disabled by an administrator.' }); }
      db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
      attempts.delete(key);
      return send(res, 200, issue(row));
    }

    const authedUser = () => {
      const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const payload = match && verifyJwt(match[1], secret);
      const user = payload ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(payload.sub)) : null;
      return user && !user.disabled_at ? user : null;
    };

    if (pathname === '/auth/me' || pathname.startsWith('/sync/') || pathname.startsWith('/chat/')) {
      const row = authedUser();
      if (!row) { return send(res, 401, { error: 'Unauthorized.' }); }

      if (pathname.startsWith('/chat/')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        if (pathname === '/chat/stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
          res.write(`data: ${JSON.stringify({ type: 'ready', unread: chat.unreadForUser(row.id) })}\n\n`);
          if (!streams.has(row.id)) streams.set(row.id, new Set());
          streams.get(row.id).add(res);
          const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
          req.on('close', () => { clearInterval(beat); const set = streams.get(row.id); if (set) { set.delete(res); if (!set.size) streams.delete(row.id); } });
          return;
        }
        if (pathname === '/chat/messages' && req.method === 'GET') {
          return send(res, 200, { ...chat.thread(row.id, { after: params.get('after') }), unread: chat.unreadForUser(row.id) });
        }
        if (pathname === '/chat/messages' && req.method === 'POST') {
          const body = await readJson(req, MAX_CHAT_BODY);
          return send(res, 201, { message: chat.post(row.id, 'user', body) });
        }
        if (pathname === '/chat/read' && req.method === 'POST') { return send(res, 200, chat.markRead(row.id, 'user')); }
        const picture = /^\/chat\/images\/(\d+)$/.exec(pathname);
        if (picture && req.method === 'GET') { return send(res, 200, chat.image(picture[1], row.id)); }
        if (pathname === '/chat/notifications' && req.method === 'GET') {
          return send(res, 200, { notifications: chat.notificationsFor(row.id), unread: chat.unreadForUser(row.id) });
        }
        if (pathname === '/chat/notifications/read' && req.method === 'POST') {
          const body = await readJson(req);
          return send(res, 200, chat.readNotifications(row.id, Array.isArray(body.ids) ? body.ids : null));
        }
        return send(res, 404, { error: 'Not found.' });
      }

      if (pathname === '/auth/me' && req.method === 'GET') { return send(res, 200, { user: publicUser(row) }); }

      if (pathname === '/auth/me' && req.method === 'PUT') {
        const body = await readJson(req);
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '';
        if (!displayName) { return send(res, 400, { error: 'Name is required.' }); }
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, row.id);
        return send(res, 200, { user: publicUser({ ...row, display_name: displayName }) });
      }

      if (pathname === '/sync/annotations' && req.method === 'GET') {
        const library = new URL(req.url, 'http://localhost').searchParams.get('library') || '';
        const saved = db.prepare('SELECT data, updated_at FROM annotations WHERE user_id = ? AND library_name = ?').get(row.id, library);
        return send(res, 200, saved ? { data: JSON.parse(saved.data), updatedAt: saved.updated_at } : { data: null });
      }

      if (pathname === '/sync/annotations' && req.method === 'PUT') {
        const body = await readJson(req, MAX_SYNC_BODY);
        const data = body.data;
        const valid = typeof body.library === 'string' && body.library && body.library.length <= 1024
          && data && Array.isArray(data.entries) && Array.isArray(data.albums) && data.entries.length <= 500000 && data.albums.length <= 50000;
        if (!valid) { return send(res, 400, { error: 'Invalid annotation payload.' }); }
        db.prepare(`INSERT INTO annotations (user_id, library_name, data, entry_count) VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, library_name) DO UPDATE SET data = excluded.data, entry_count = excluded.entry_count, updated_at = datetime('now')`)
          .run(row.id, body.library, JSON.stringify(data), data.entries.length);
        return send(res, 200, { saved: true, count: data.entries.length });
      }
    }

    return send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(err => { if (res.headersSent) { res.end(); return; } send(res, err.status || 500, { error: err.status ? err.message : 'Server error.' }); });
  });
  server.chat = chat;
  server.on('close', () => { for (const set of streams.values()) for (const res of set) res.end(); });
  return server;
}

module.exports = { createApp };
