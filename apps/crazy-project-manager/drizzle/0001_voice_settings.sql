CREATE TABLE IF NOT EXISTS studio_voice_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'shared'),
  revision TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
