import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from './errors.mjs';
export { httpError } from './errors.mjs';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function openStore(directory) {
  const assetsDirectory = path.join(directory, 'assets');
  mkdirSync(assetsDirectory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'studio.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 4000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT REFERENCES sessions(id), seq INTEGER, body TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS commands (
      session_id TEXT REFERENCES sessions(id), id TEXT, receipt TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      session_id TEXT REFERENCES sessions(id), seq INTEGER, body TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS presentation (
      session_id TEXT REFERENCES sessions(id), page_id TEXT, client_seq INTEGER,
      observed_seq INTEGER NOT NULL, at REAL NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (session_id, page_id, client_seq)
    );
    CREATE INDEX IF NOT EXISTS presentation_by_time ON presentation(session_id, at);
    CREATE TABLE IF NOT EXISTS assets (
      hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS speech_cache (
      request_hash TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES assets(hash)
    );
    CREATE TABLE IF NOT EXISTS session_media (
      session_id TEXT REFERENCES sessions(id), hash TEXT REFERENCES assets(hash),
      observed_seq INTEGER NOT NULL, at REAL NOT NULL, metadata TEXT NOT NULL,
      PRIMARY KEY (session_id, hash, metadata)
    );
  `);

  const prepare = sql => db.prepare(sql);
  const selectSession = prepare('SELECT state FROM sessions WHERE id = ?');
  const selectAllSessions = prepare('SELECT state FROM sessions ORDER BY created_at DESC');
  const insertSession = prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const updateSession = prepare('UPDATE sessions SET state = ? WHERE id = ?');
  const insertEvent = prepare('INSERT INTO events VALUES (?, ?, ?)');
  const selectEvents = prepare('SELECT body FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq');
  const insertCommand = prepare('INSERT INTO commands VALUES (?, ?, ?)');
  const selectCommand = prepare('SELECT receipt FROM commands WHERE session_id = ? AND id = ?');
  const insertSnapshot = prepare('INSERT INTO snapshots VALUES (?, ?, ?)');
  const selectSnapshots = prepare('SELECT body FROM snapshots WHERE session_id = ? AND seq <= ? ORDER BY seq');
  const insertPresentation = prepare('INSERT OR IGNORE INTO presentation VALUES (?, ?, ?, ?, ?, ?)');
  const selectPresentation = prepare('SELECT body FROM presentation WHERE session_id = ? AND observed_seq <= ? AND at <= ? ORDER BY at, page_id, client_seq');
  const insertAsset = prepare('INSERT OR IGNORE INTO assets VALUES (?, ?, ?)');
  const selectAsset = prepare('SELECT hash, mime, bytes FROM assets WHERE hash = ?');
  const selectSpeech = prepare('SELECT hash FROM speech_cache WHERE request_hash = ?');
  const indexSpeech = prepare('INSERT INTO speech_cache VALUES (?, ?) ON CONFLICT(request_hash) DO UPDATE SET hash = excluded.hash');
  const insertMedia = prepare('INSERT OR IGNORE INTO session_media VALUES (?, ?, ?, ?, ?)');
  const selectMedia = prepare('SELECT hash, metadata, at FROM session_media WHERE session_id = ? AND observed_seq <= ? AND at <= ? ORDER BY at');

  const parseState = row => row && JSON.parse(row.state);
  const parseBodies = rows => rows.map(row => JSON.parse(row.body));
  const read = id => parseState(selectSession.get(id));
  function atomic(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function persist(state, events, snapshot) {
    updateSession.run(JSON.stringify(state), state.id);
    for (const event of events) insertEvent.run(state.id, event.seq, JSON.stringify(event));
    if (snapshot) insertSnapshot.run(state.id, snapshot.seq, JSON.stringify(snapshot));
  }

  function asset(hash, { verify = false } = {}) {
    if (!/^[a-f0-9]{64}$/.test(hash ?? '')) return null;
    const row = selectAsset.get(hash);
    if (!row) return null;
    const filename = path.join(assetsDirectory, hash);
    if (!existsSync(filename)) return null;
    if (verify) {
      const bytes = readFileSync(filename);
      if (bytes.length !== row.bytes || sha256(bytes) !== hash) return null;
    }
    return { ...row, filename, url: `/api/media/${hash}` };
  }

  function saveAsset(content, mime) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = sha256(bytes);
    const filename = path.join(assetsDirectory, hash);
    if (!existsSync(filename) || sha256(readFileSync(filename)) !== hash) {
      const temporary = path.join(assetsDirectory, `${hash}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', flush: true });
        if (sha256(readFileSync(temporary)) !== hash) throw new Error('资源校验失败');
        renameSync(temporary, filename);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    insertAsset.run(hash, mime, bytes.length);
    return { hash, mime, url: `/api/media/${hash}` };
  }

  const speechCache = {
    get(key) {
      const entry = asset(selectSpeech.get(key)?.hash);
      if (!entry || entry.mime !== 'audio/mpeg' || entry.bytes > 1_280_000) return null;
      const audio = readFileSync(entry.filename);
      if (audio.length !== entry.bytes || sha256(audio) !== entry.hash) return null;
      return { audio, asset: { hash: entry.hash, mime: entry.mime, url: entry.url } };
    },
    set(key, entry) {
      indexSpeech.run(key, entry.hash);
    },
  };

  return {
    read, asset, saveAsset, speechCache,
    readAsset(hash, options) {
      const entry = asset(hash, options);
      return entry ? readFileSync(entry.filename) : null;
    },
    require(id) {
      const state = read(id);
      if (!state) throw httpError(404, '找不到这局项目。');
      return state;
    },
    list: () => selectAllSessions.all().map(parseState),
    close: () => db.close(),
    create(state, events, snapshot) {
      atomic(() => {
        insertSession.run(state.id, state.startedAt, '{}');
        persist(state, events, snapshot);
      });
    },
    change(id, commandId, run) {
      return atomic(() => {
        const state = read(id);
        if (!state) throw httpError(404, '找不到这局项目。');
        if (commandId) {
          const prior = selectCommand.get(id, commandId);
          if (prior) return { state, ...JSON.parse(prior.receipt), duplicate: true };
        }
        const { events, result, snapshot, error, statusCode } = run(state);
        if (events.length) persist(state, events, snapshot);
        const receipt = { events, result, error, statusCode };
        if (commandId) insertCommand.run(id, commandId, JSON.stringify(receipt));
        return { state, ...receipt };
      });
    },
    events: (id, after = 0, until = Number.MAX_SAFE_INTEGER) => parseBodies(selectEvents.all(id, after, until)),
    snapshots: (id, until) => parseBodies(selectSnapshots.all(id, until)),
    present(id, records) {
      return atomic(() => records.map(record => {
        insertPresentation.run(id, record.pageId, record.clientSeq, record.observedSeq, record.at, JSON.stringify(record));
        return [record.pageId, record.clientSeq];
      }));
    },
    presentation: (id, until, at) => parseBodies(selectPresentation.all(id, until, at)),
    attachMedia(id, hash, observedSeq, at, meta) {
      insertMedia.run(id, hash, observedSeq, at, JSON.stringify(meta));
    },
    media: (id, until, at) => selectMedia.all(id, until, at).map(row => ({ hash: row.hash, at: row.at, meta: JSON.parse(row.metadata) }))
  };
}
