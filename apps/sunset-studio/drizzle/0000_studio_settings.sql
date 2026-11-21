CREATE TABLE studio_settings (
  kind TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  encrypted_value TEXT NOT NULL
);
