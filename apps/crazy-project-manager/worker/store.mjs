import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { httpError } from '../server/errors.mjs';
import { patchAssetHashes, sceneAssetHashes } from '../server/designer-model.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const assetKey = hash => `asset/${hash}`;
const json = JSON.stringify;
const isHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);

export async function writeAsset(env, content, mime) {
  const bytes = Buffer.from(content);
  const hash = sha256(bytes);
  await env.BUCKET.put(assetKey(hash), bytes, { httpMetadata: { contentType: mime } });
  return { hash, mime, url: `/api/media/${hash}` };
}

export async function loadState(env, owner, id) {
  const row = await env.DB.prepare('SELECT revision, state FROM studio_sessions WHERE owner = ? AND id = ?').bind(owner, id).first();
  if (!row) throw httpError(404, '找不到这项项目。');
  return { revision: row.revision, state: JSON.parse(row.state) };
}

export async function listStates(env, owner) {
  const { results } = await env.DB.prepare('SELECT state FROM studio_sessions WHERE owner = ? ORDER BY updated_at DESC LIMIT 30').bind(owner).all();
  return results.map(row => JSON.parse(row.state));
}

export async function loadEvents(env, id, after = 0, until = Number.MAX_SAFE_INTEGER) {
  const { results } = await env.DB.prepare('SELECT body FROM studio_events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq').bind(id, after, until).all();
  return results.map(row => JSON.parse(row.body));
}

function referenceHashes(state, command) {
  const hashes = new Set();
  const version = id => state.versions.find(item => item.id === id);
  const addScene = source => {
    if (source?.scene) for (const hash of sceneAssetHashes(source.scene)) hashes.add(hash);
  };
  const job = state.job;
  const scheduled = job?.status === 'working' || (job?.status === 'paused' && job.autoResume === true);
  if (scheduled && job.progress + (job.rushed ? 20 : 10) >= 100 && !command) {
    addScene(version(job.baseVersionId));
    if (job.baseDraftId && state.draft?.id === job.baseDraftId) addScene(state.draft);
    for (const hash of patchAssetHashes(job.patches)) hashes.add(hash);
  }
  if (command) {
    const target = version(command.payload?.versionId ?? state.selectedVersionId);
    if (command.type === 'restore') addScene(target);
    if (command.type === 'upload' || command.type === 'canvasEdit') {
      const base = state.draft?.baseVersionId === state.selectedVersionId ? state.draft : version(state.selectedVersionId);
      addScene(base);
    }
    if (command.type === 'verifyReservation') hashes.add(target?.hash);
    if (command.type === 'export') hashes.add(command.payload?.format?.toLowerCase() === 'png' ? target?.pngHash : target?.hash);
  }
  return [...hashes].filter(isHash);
}

export async function openSessionStore(env, owner, { id, command, loaded } = {}) {
  const initial = id ? loaded ?? await loadState(env, owner, id) : null;
  let state = initial?.state ?? null;
  let revision = initial?.revision ?? null;
  const binaries = new Map();
  const unflushed = new Map();
  const receipts = new Map();
  let write = null;

  async function fetchAsset(hash) {
    if (!isHash(hash)) return null;
    if (binaries.has(hash)) return binaries.get(hash);
    const object = await env.BUCKET.get(assetKey(hash));
    if (!object) return null;
    const bytes = Buffer.from(await object.arrayBuffer());
    if (sha256(bytes) !== hash) return null;
    const asset = { hash, mime: object.httpMetadata?.contentType ?? 'application/octet-stream', bytes, url: `/api/media/${hash}` };
    binaries.set(hash, asset);
    return asset;
  }

  async function loadReceipt() {
    if (typeof command?.id !== 'string') return;
    const row = await env.DB.prepare('SELECT receipt FROM studio_commands WHERE session_id = ? AND id = ?').bind(id, command.id).first();
    if (row) receipts.set(command.id, JSON.parse(row.receipt));
  }

  if (state) await Promise.all([loadReceipt(), ...referenceHashes(state, command).map(fetchAsset)]);

  function requireState(sessionId) {
    if (state?.id !== sessionId) throw httpError(404, '找不到这项项目。');
    return state;
  }

  async function flush() {
    if (!write) return;
    await Promise.all([...unflushed.values()].map(asset => env.BUCKET.put(assetKey(asset.hash), asset.bytes, { httpMetadata: { contentType: asset.mime } })));
    const { events, snapshot, commandId, receipt } = write;
    const token = crypto.randomUUID();
    const { id } = state;
    const statement = sql => env.DB.prepare(sql);
    const current = 'EXISTS (SELECT 1 FROM studio_sessions WHERE id = ? AND revision = ?)';
    const updates = [revision === null
      ? statement('INSERT INTO studio_sessions (id, owner, updated_at, revision, state) VALUES (?, ?, ?, ?, ?)').bind(id, owner, state.lastAt, token, json(state))
      : statement('UPDATE studio_sessions SET updated_at=?, revision=?, state=? WHERE id=? AND owner=? AND revision=?').bind(state.lastAt, token, json(state), id, owner, revision)];
    for (const event of events) updates.push(statement(`INSERT INTO studio_events SELECT ?, ?, ? WHERE ${current}`).bind(id, event.seq, json(event), id, token));
    if (snapshot) updates.push(statement(`INSERT INTO studio_snapshots SELECT ?, ?, ? WHERE ${current}`).bind(id, snapshot.seq, json(snapshot), id, token));
    if (commandId) updates.push(statement(`INSERT INTO studio_commands SELECT ?, ?, ? WHERE ${current}`).bind(id, commandId, json(receipt), id, token));
    const [result] = await env.DB.batch(updates);
    if (result.meta.changes !== 1) throw httpError(409, '项目刚有更新，请重试这个操作。');
    revision = token;
    write = null;
    unflushed.clear();
  }

  function change(sessionId, commandId, run) {
    requireState(sessionId);
    if (commandId && receipts.has(commandId)) return { state, ...receipts.get(commandId), duplicate: true };
    if (write) throw new Error('Worker 会话更新需要先提交。');
    const next = structuredClone(state);
    const { events, result, snapshot, error, statusCode } = run(next);
    const receipt = { events, result, error, statusCode };
    if (events.length || commandId) {
      state = next;
      write = { events, snapshot, commandId, receipt };
      if (commandId) receipts.set(commandId, receipt);
    }
    return { state, ...receipt };
  }

  return {
    read: requireState, require: requireState, flush, change,
    async commitTurn(run) {
      for (let attempt = 0; ; attempt++) {
        ({ state, revision } = await loadState(env, owner, id));
        const result = change(id, null, run);
        try {
          await flush();
          return result;
        } catch (error) {
          if (error.statusCode !== 409 || attempt === 2) throw error;
          write = null;
        }
      }
    },
    asset(hash) { return binaries.get(hash) ?? null; },
    readAsset(hash) {
      if (binaries.has(hash)) return binaries.get(hash).bytes;
      return fetchAsset(hash).then(asset => asset?.bytes ?? null);
    },
    saveAsset(content, mime) {
      const bytes = Buffer.from(content);
      const hash = sha256(bytes);
      const asset = { hash, mime, bytes, url: `/api/media/${hash}` };
      if (!binaries.has(hash)) unflushed.set(hash, asset);
      binaries.set(hash, asset);
      return { hash, mime, url: asset.url };
    },
    create(next, events, snapshot) {
      state = next;
      write = { events, snapshot };
    }
  };
}
