CREATE TABLE IF NOT EXISTS studio_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision TEXT NOT NULL,
  state TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS studio_sessions_owner ON studio_sessions(owner, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_events (
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_commands (
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(session_id, id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_snapshots (
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_presentation (
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  page_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  observed_seq INTEGER NOT NULL,
  at REAL NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(session_id, page_id, client_seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS studio_presentation_by_time ON studio_presentation(session_id, at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_media (
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  hash TEXT NOT NULL,
  observed_seq INTEGER NOT NULL,
  at REAL NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (session_id, hash, metadata)
);
