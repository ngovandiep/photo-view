CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  password_hash TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'linkedin')),
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  root_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS annotations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_name TEXT NOT NULL,
  data TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, library_name)
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT NOT NULL,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (library_id, id)
);

CREATE TABLE IF NOT EXISTS entries (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL DEFAULT '',
  size INTEGER,
  modified_at INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  album_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (library_id, path)
) WITHOUT ROWID;
