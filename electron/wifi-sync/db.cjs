'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const STATES = ['discovered', 'queued', 'uploading', 'stored', 'indexed', 'failed_retryable', 'failed_permanent', 'cancelled'];

// Each migration runs once, in order; PRAGMA user_version records how many have been applied.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    last_sync_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE sync_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (device_id, idempotency_key)
  );

  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    session_id TEXT REFERENCES sync_sessions(id),
    source_asset_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
    size INTEGER NOT NULL,
    captured_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('${STATES.join("','")}')),
    bytes_received INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at INTEGER,
    sha256 TEXT,
    duplicate_of TEXT REFERENCES assets(id),
    library_id TEXT,
    library_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    stored_at INTEGER,
    indexed_at INTEGER,
    UNIQUE (device_id, source_asset_id)
  );
  CREATE INDEX idx_assets_state ON assets(state);
  CREATE INDEX idx_assets_session ON assets(session_id);
  CREATE UNIQUE INDEX idx_assets_library_file ON assets(library_id, library_path) WHERE library_path IS NOT NULL;
  CREATE INDEX idx_assets_sha ON assets(sha256) WHERE sha256 IS NOT NULL;

  CREATE TABLE idempotent_responses (
    device_id TEXT NOT NULL,
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, key, endpoint)
  );
  `,
  `
  ALTER TABLE assets ADD COLUMN folder_path TEXT;
  ALTER TABLE assets ADD COLUMN device_deleted_at INTEGER;
  `,
  `
  ALTER TABLE devices ADD COLUMN removed_at INTEGER;

  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('operational', 'security')),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    device_id TEXT,
    session_id TEXT,
    result TEXT NOT NULL DEFAULT 'success'
  );
  CREATE INDEX idx_activity_ts ON activity_log(ts DESC);
  CREATE INDEX idx_activity_device ON activity_log(device_id);
  `,
  `
  ALTER TABLE assets ADD COLUMN expected_sha256 TEXT;
  ALTER TABLE assets ADD COLUMN duplicate_library_path TEXT;
  `,
  `
  CREATE TABLE family_profiles (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'contributor')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  ALTER TABLE devices ADD COLUMN profile_id TEXT REFERENCES family_profiles(id);
  ALTER TABLE devices ADD COLUMN upload_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE devices ADD COLUMN allow_images INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE devices ADD COLUMN allow_videos INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE devices ADD COLUMN max_file_size_mb INTEGER NOT NULL DEFAULT 4096;
  CREATE TABLE album_grants (
    profile_id TEXT NOT NULL REFERENCES family_profiles(id),
    library_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    PRIMARY KEY (profile_id, library_id, album_id)
  );
  CREATE TABLE family_logins (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    profile_id TEXT NOT NULL REFERENCES family_profiles(id)
  );
  `
];

function openSyncDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) { db.close(); throw new Error('Sync database requires a newer version of MiLeo.'); }
  if (current === 4 && file !== ':memory:') {
    const snapshot = `${file}.pre-family-${require('node:crypto').randomUUID()}.db`;
    try {
      db.prepare('VACUUM INTO ?').run(snapshot);
      const backup = new DatabaseSync(snapshot, { readOnly: true });
      try {
        if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || backup.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Pre-family sync snapshot verification failed.');
      } finally { backup.close(); }
    } catch (error) { db.close(); throw error; }
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { openSyncDb, transaction, STATES, MIGRATION_COUNT: MIGRATIONS.length };
