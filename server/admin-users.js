'use strict';
const { hashPassword } = require('./auth');

const { ROLES } = require('./roles');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Account management used by the desktop admin dashboard. Password hashes never leave this module.
function createUserAdmin(db) {
  const role = value => {
    const next = String(value || 'viewer').toLowerCase();
    if (!ROLES.includes(next)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    return next;
  };

  function list() {
    return db.prepare('SELECT id, email, display_name, role, created_at, last_login_at, disabled_at FROM users ORDER BY id').all();
  }

  function create({ email, displayName, password, role: requested }) {
    const address = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(address) || address.length > 320) throw new Error('A valid email is required.');
    const secret = String(password || '');
    if (secret.length < 8 || secret.length > 200) throw new Error('Password must be 8-200 characters.');
    const chosen = role(requested);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(address)) throw new Error('Email is already registered.');
    const name = String(displayName || '').trim().slice(0, 100) || address.split('@')[0];
    const id = Number(db.prepare('INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
      .run(address, hashPassword(secret), name, chosen).lastInsertRowid);
    return { id, email: address, role: chosen };
  }

  function setRole(id, requested) {
    const chosen = role(requested);
    const found = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(Number(id));
    if (!found) throw new Error('User not found.');
    // Keep at least one active administrator so the role can't be removed from everyone.
    if (found.role === 'admin' && chosen !== 'admin'
      && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?").get(found.id).n === 0) {
      throw new Error('At least one active admin account must remain.');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(chosen, found.id);
    return { id: found.id, email: found.email, role: chosen, previous: found.role };
  }

  return { list, create, setRole, ROLES };
}

module.exports = { createUserAdmin, ROLES };
