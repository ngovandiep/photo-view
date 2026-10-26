'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function openDb(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'still.db')) {
  if (file !== ':memory:') { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// Finds or creates the user for a provider identity; links by email only when the provider verified it.
function upsertUser(db, { provider, providerUserId, email, emailVerified, displayName, avatarUrl }) {
  const existing = db.prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?').get(provider, providerUserId);
  let userId = existing && existing.user_id;
  if (!userId && email && emailVerified) {
    const byEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    userId = byEmail && byEmail.id;
  }
  if (!userId) {
    userId = Number(db.prepare('INSERT INTO users (email, display_name, avatar_url) VALUES (?, ?, ?)')
      .run(email || null, displayName || '', avatarUrl || null).lastInsertRowid);
  }
  db.prepare('INSERT OR IGNORE INTO identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)').run(userId, provider, providerUserId);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return userId;
}

module.exports = { openDb, upsertUser };
