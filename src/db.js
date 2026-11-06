const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en',
  avatar TEXT NOT NULL, color TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'worker',
  location_consent TEXT, location_consent_ts INTEGER
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, names TEXT NOT NULL, color TEXT NOT NULL,
  symbol TEXT NOT NULL, crop TEXT, polygon TEXT NOT NULL,
  restricted_until INTEGER, restricted_reason TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
  fence_zone_id TEXT REFERENCES zones(id), holder_id TEXT REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS tags (
  uid TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_type TEXT, owner_id TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL
);

-- Every change arrives as an op with a device-made id, so a phone can safely resend after a dropped connection.
CREATE TABLE IF NOT EXISTS ops (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, person_id TEXT, ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL, payload TEXT NOT NULL
);

-- Append-only: corrections are new rows marked with who entered them, never edits.
CREATE TABLE IF NOT EXISTS punches (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), type TEXT NOT NULL,
  ts INTEGER NOT NULL, received_at INTEGER NOT NULL, lat REAL, lng REAL, accuracy REAL,
  zone_id TEXT, method TEXT NOT NULL, entered_by TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS punches_person_ts ON punches (person_id, ts);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, thing TEXT, zone_id TEXT REFERENCES zones(id), qty INTEGER,
  assignee_id TEXT REFERENCES people(id), created_by TEXT REFERENCES people(id),
  origin TEXT NOT NULL, status TEXT NOT NULL, problem TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL,
  person_id TEXT, reason TEXT, ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, person_id TEXT REFERENCES people(id), task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL, text TEXT, media TEXT, lat REAL, lng REAL, zone_id TEXT, ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sightings (
  id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, tag_uid TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, zone_id TEXT, source TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sightings_owner_ts ON sightings (owner_type, owner_id, ts);

CREATE TABLE IF NOT EXISTS presence (
  owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
  zone_id TEXT, source TEXT NOT NULL, ts INTEGER NOT NULL, outside_fence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
  zone_id TEXT, ts INTEGER NOT NULL, acked_at INTEGER, resolved_at INTEGER
);
`;

export function applySchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}
