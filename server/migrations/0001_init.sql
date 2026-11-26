-- Agent memory: one fact per note, shared by every agent.

CREATE TABLE projects (
  key         TEXT PRIMARY KEY,            -- e.g. "my-app", "_global"
  title       TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',  -- JSON array of normalized folder paths and git remotes
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO projects (key, title) VALUES ('_global', 'Global (applies everywhere)');

-- Monotonic change counter: every note insert or change takes the next value (used by the backup cursor).
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('change', 0);

CREATE TABLE notes (
  nid           INTEGER PRIMARY KEY AUTOINCREMENT, -- stable row id for the search index
  id            TEXT NOT NULL,             -- slug, unique per project
  project       TEXT NOT NULL REFERENCES projects(key),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  body          TEXT NOT NULL,
  links         TEXT NOT NULL DEFAULT '[]', -- JSON array of [[link]] targets
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'muted', 'deleted')),
  status_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  source_hash   TEXT,                       -- hash of the local file at import time
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by    TEXT NOT NULL DEFAULT 'unknown',
  change_seq    INTEGER NOT NULL DEFAULT 0, -- set by triggers from counters.change
  UNIQUE (project, id)
);

CREATE INDEX notes_change_seq ON notes (change_seq);

-- Full-text search (unicode61 handles Arabic and Latin; diacritics folded).
CREATE VIRTUAL TABLE notes_fts USING fts5 (
  name, description, body,
  content = 'notes',
  content_rowid = 'nid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, name, description, body) VALUES (new.nid, new.name, new.description, new.body);
  UPDATE counters SET value = value + 1 WHERE name = 'change';
  UPDATE notes SET change_seq = (SELECT value FROM counters WHERE name = 'change') WHERE nid = new.nid;
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, name, description, body) VALUES ('delete', old.nid, old.name, old.description, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF name, description, body ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, name, description, body) VALUES ('delete', old.nid, old.name, old.description, old.body);
  INSERT INTO notes_fts (rowid, name, description, body) VALUES (new.nid, new.name, new.description, new.body);
END;
-- Any content or status change takes the next change number (change_seq itself is not in the list, so no loop).
CREATE TRIGGER notes_change AFTER UPDATE OF name, description, type, body, links, status, status_reason, version ON notes BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'change';
  UPDATE notes SET change_seq = (SELECT value FROM counters WHERE name = 'change') WHERE nid = new.nid;
END;

-- Full previous text of every edit, so any change can be undone.
CREATE TABLE note_versions (
  project     TEXT NOT NULL,
  id          TEXT NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  type        TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,
  saved_at    TEXT NOT NULL,
  saved_by    TEXT NOT NULL,
  PRIMARY KEY (project, id, version)
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,       -- SHA-256 hex of the token; the token itself is never stored
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE audit (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor    TEXT NOT NULL,                  -- device name or "github:<login>"
  action   TEXT NOT NULL,                  -- create, update, mute, unmute, delete, restore, rollback, link, project
  project  TEXT,
  note_id  TEXT,
  detail   TEXT
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
