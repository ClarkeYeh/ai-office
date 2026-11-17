CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workflow_id TEXT,
  external_key TEXT,
  event_json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_external_key ON events(external_key);
CREATE INDEX events_workflow_seq ON events(workflow_id, seq);
CREATE TABLE ingest_cursors (
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (source, scope)
);
CREATE TABLE projections (
  workflow_id TEXT PRIMARY KEY NOT NULL,
  read_model_json TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE seat_tokens (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
