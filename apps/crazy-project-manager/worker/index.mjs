import { Buffer } from 'node:buffer';
import { activeAgent, settingsDefaults } from '../server/runtime-config.mjs';
import { createDialogueModel } from '../server/dialogue-model.mjs';
import { createDesignerModel } from '../server/designer-model.mjs';
import { createSessions, publicState, readyDesignerGuidance } from '../server/sessions.mjs';
import { nextRoundSlot, pendingRound, readyMeetingAssignment } from '../server/review-rounds.mjs';
import { localizeEvent, localizeReplaySubtitles, localizeSession, localizedResponse } from '../server/session-language.mjs';
import { roleLanguage } from '../server/role-language.mjs';
import { projectTheme } from '../server/project-theme.mjs';
import { theme } from '../server/poster.mjs';
import { httpError } from '../server/errors.mjs';
import * as poster from './poster.mjs';
import { serveStatic } from './static.mjs';
import { workerVoice } from './voice.mjs';
import { readSharedSettings, sharedSettingsStatus } from './voice-settings.mjs';
import { assetKey, listStates, loadEvents, loadState, openSessionStore, writeAsset } from './store.mjs';

const encoder = new TextEncoder();
const uid = '[a-f0-9-]{36}';
const hashPattern = '[a-f0-9]{64}';
const sessionPath = new RegExp(`^/api/sessions/(${uid})(.*)$`);
const audioTypes = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/x-wav', 'video/webm']);
const security = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const json = (value, status = 200) => Response.json(value, { status, headers: security });

function visitor(request, url) {
  const account = request.headers.get('oai-authenticated-user-id');
  if (account) return { owner: `account:${account}` };
  const existing = request.headers.get('cookie')?.match(/(?:^|;\s*)studio_guest=([a-f0-9-]{36})(?:;|$)/)?.[1];
  const id = existing ?? crypto.randomUUID();
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return { owner: `guest:${id}`, cookie: existing ? null : `studio_guest=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` };
}

function withCookie(response, identity) {
  if (!identity.cookie || response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', identity.cookie);
  return new Response(response.body, { status: response.status, headers });
}

async function body(request, limit = 128 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) throw httpError(413, '这次提交的数据超出大小限制。');
  const content = await request.text();
  if (Buffer.byteLength(content) > limit) throw httpError(413, '这次提交的数据超出大小限制。');
  try {
    const parsed = JSON.parse(content || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw httpError(400, '提交内容不是有效的 JSON。');
  }
}

function engine(store, config) {
  const { text, vision } = activeAgent(config);
  return createSessions(store, {
    poster, autoSchedule: false,
    getDialogueModel: () => createDialogueModel(text, vision),
    getDesignerModel: () => createDesignerModel(text),
    getImageConfig: () => config.image
  });
}

async function objectResponse(request, env, key, { download, expires = false, cache = 'private, max-age=31536000, immutable' } = {}) {
  const head = await env.BUCKET.head(key);
  if (!head || (expires && Number(head.customMetadata?.expires) <= Date.now())) {
    if (head && expires) await env.BUCKET.delete(key);
    throw httpError(404, '找不到这项资源。');
  }
  const headers = new Headers(security);
  headers.set('Content-Type', head.httpMetadata?.contentType ?? 'application/octet-stream');
  if (!expires) headers.set('Cache-Control', cache);
  headers.set('Accept-Ranges', 'bytes');
  if (download) headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  const requested = request.headers.get('range');
  let range, status = 200;
  if (requested) {
    const span = /^bytes=(\d*)-(\d*)$/.exec(requested);
    const start = span?.[1] ? Number(span[1]) : Math.max(0, head.size - Number(span?.[2]));
    const end = span?.[1] && span?.[2] ? Math.min(head.size - 1, Number(span[2])) : head.size - 1;
    if (!span || start >= head.size || start > end || !Number.isFinite(start)) {
      headers.set('Content-Range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
    status = 206;
  }
  headers.set('Content-Length', String(range?.length ?? head.size));
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const file = await env.BUCKET.get(key, range ? { range } : undefined);
  if (!file) throw httpError(404, '找不到这项资源。');
  return new Response(file.body, { status, headers });
}

async function voiceRequest(request, env, ctx, settings, url) {
  let staged;
  try {
    return await workerVoice(request, env, {
      settings,
      saveMedia: (bytes, mime) => writeAsset(env, bytes, mime),
      keepAlive: operation => ctx.waitUntil(operation),
      async makeAudioUrl(bytes, mime) {
        const origin = env.STUDIO_PUBLIC_URL ? new URL(env.STUDIO_PUBLIC_URL).origin : url.origin;
        if (!origin.startsWith('https://')) throw httpError(422, '火山标准版需要外网可访问的 HTTPS 录音地址。');
        const id = crypto.randomUUID();
        staged = `asr/${id}`;
        await env.BUCKET.put(staged, bytes, { httpMetadata: { contentType: mime }, customMetadata: { expires: String(Date.now() + 15 * 60 * 1000) } });
        return `${origin}/api/asr-source/${id}`;
      }
    });
  } finally {
    if (staged) ctx.waitUntil(env.BUCKET.delete(staged).catch(error => console.error('临时录音清理失败', error.message)));
  }
}

function subscribe(request, env, ctx, defaults, owner, id, url) {
  let cancelled = false;
  const language = url.searchParams.get('lang');
  let last = Math.max(0, Number(request.headers.get('last-event-id')) || 0, Number(url.searchParams.get('after')) || 0);
  let live;
  const stream = new ReadableStream({
    start(controller) {
      const send = text => { if (!cancelled) controller.enqueue(encoder.encode(text)); };
      send('retry: 900\n\n');
      live = (async () => {
        let first = true;
        let silence = 0;
        while (!cancelled && !request.signal.aborted) {
          const loaded = await loadState(env, owner, id);
          if (first || loaded.state.seq > last) {
            first = false;
            last = Math.min(last, loaded.state.seq);
            const events = await loadEvents(env, id, last, loaded.state.seq);
            last = loaded.state.seq;
            const update = localizedResponse({ state: publicState(loaded.state), events }, language);
            send(`id: ${last}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`);
            silence = 0;
          }
          const { job, pendingQuestions, pendingTurn } = loaded.state;
          const now = Date.now();
          const scheduled = job?.status === 'working' || (job?.status === 'paused' && job.autoResume === true);
          const due = scheduled && Number.isFinite(job.dueAt) && job.dueAt <= now;
          const planning = job?.status === 'planning' && (job.planClaim?.expiresAt ?? 0) <= now;
          const round = pendingRound(loaded.state);
          const queued = round && nextRoundSlot(round, now);
          if (due || planning || queued || readyMeetingAssignment(loaded.state) || readyDesignerGuidance(loaded.state) || pendingQuestions?.length || pendingTurn) {
            const heartbeat = setInterval(() => send(': heartbeat\n\n'), 12500);
            try {
              if (due) await poster.initializePoster();
              const config = await readSharedSettings(env, defaults);
              const store = await openSessionStore(env, owner, { id, loaded });
              await engine(store, config).advance(id, {
                signal: request.signal,
                onMeetingChunk: chunk => send(`event: meeting-speech\ndata: ${JSON.stringify(chunk)}\n\n`),
                onDesignerSpeech: chunk => send(`event: designer-speech\ndata: ${JSON.stringify(chunk)}\n\n`),
              });
            } catch (error) {
              if (error.statusCode !== 409 && !cancelled) console.error('Worker 会话推进失败', error.message);
            } finally {
              clearInterval(heartbeat);
            }
          }
          const interval = scheduled ? 220 : 700;
          silence += interval;
          if (silence > 14000) {
            send(': heartbeat\n\n');
            silence = 0;
          }
          await new Promise(resolve => setTimeout(resolve, interval));
        }
      })().catch(() => {}).finally(() => { if (!cancelled) controller.close(); });
      ctx.waitUntil(live);
    },
    cancel() { cancelled = true; }
  });
  return new Response(stream, { headers: { ...security, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' } });
}

async function replay(env, state, url) {
  const id = state.id;
  const language = roleLanguage(url.searchParams.get('lang') ?? state.language);
  const limit = url.searchParams.has('until') ? Number(url.searchParams.get('until')) : state.seq;
  const untilSeq = Number.isSafeInteger(limit) ? Math.min(state.seq, Math.max(0, limit)) : state.seq;
  const sealedAt = Date.now() + 80;
  const [events, snapshots, presentation, media] = await Promise.all([
    loadEvents(env, id, 0, untilSeq).then(entries => entries.map(event => localizeEvent(event, language))),
    env.DB.prepare('SELECT body FROM studio_snapshots WHERE session_id=? AND seq<=? ORDER BY seq').bind(id, untilSeq).all().then(row => row.results.map(item => JSON.parse(item.body))),
    env.DB.prepare('SELECT body FROM studio_presentation WHERE session_id=? AND observed_seq<=? AND at<=? ORDER BY at').bind(id, untilSeq, sealedAt).all().then(row => row.results.map(item => JSON.parse(item.body))),
    env.DB.prepare('SELECT hash, at, metadata FROM studio_media WHERE session_id=? AND observed_seq<=? AND at<=? ORDER BY at').bind(id, untilSeq, sealedAt).all().then(row => row.results.map(item => ({ hash: item.hash, at: item.at, meta: JSON.parse(item.metadata) })))
  ]);
  const versions = events.filter(event => event.type === 'version').map(event => event.data.version);
  const expected = new Set([...versions.flatMap(version => [version.hash, version.pngHash, version.uploadHash, ...(version.assetHashes ?? [])]),
    ...media.map(item => item.hash), ...presentation.map(item => item.data?.hash)].filter(value => new RegExp(`^${hashPattern}$`).test(value ?? '')));
  const assets = {}, missing = [];
  await Promise.all([...expected].map(async hash => {
    const file = await env.BUCKET.head(assetKey(hash));
    if (file) assets[hash] = { url: `/api/media/${hash}`, hash, bytes: file.size, mime: file.httpMetadata?.contentType ?? 'application/octet-stream' };
    else missing.push(hash);
  }));
  return { format: 'crazy-project-manager/replay', version: 1, animation: state.appearance ?? 'manga-2', sessionId: id, theme: state.theme, language,
    startedAt: state.startedAt, untilSeq, sealedAt, versions, events, snapshots, presentation: localizeReplaySubtitles(presentation, events), media, assets, missing };
}

async function sessionRequest(request, env, ctx, defaults, identity, id, suffix, url) {
  const loaded = await loadState(env, identity.owner, id);
  const { state } = loaded;
  const language = url.searchParams.get('lang');
  const read = request.method === 'GET' || request.method === 'HEAD';
  const post = request.method === 'POST';
  if (!suffix && read) return json(localizeSession(publicState(state), language));
  if (suffix === '/events' && read) return subscribe(request, env, ctx, defaults, identity.owner, id, url);
  if (suffix === '/commands' && post) {
    await poster.initializePoster();
    const command = await body(request, 12 * 1024 * 1024);
    const config = await readSharedSettings(env, defaults);
    const origin = env.STUDIO_PUBLIC_URL ? new URL(env.STUDIO_PUBLIC_URL).origin : url.origin;
    const reservationUrl = `${origin}${theme.reservationPath}`;
    for (let attempt = 0; ; attempt++) {
      const current = attempt === 0 ? loaded : await loadState(env, identity.owner, id);
      const store = await openSessionStore(env, identity.owner, { id, command, loaded: current });
      const { statusCode, ...result } = engine(store, config).command(id, command, { reservationUrl, verified: reservationUrl === current.state.reservationUrl });
      try {
        await store.flush();
        return json(localizedResponse(result, language), statusCode ?? 200);
      } catch (error) {
        if (error.statusCode !== 409 || attempt === 2) throw error;
      }
    }
  }
  if (suffix === '/presentation' && post) {
    const { records } = await body(request, 1024 * 1024);
    if (!Array.isArray(records) || records.length > 200) throw httpError(400, '操作轨迹批次无效。');
    const statements = records.map(record => {
      if (!record || !/^[\w-]{1,96}$/.test(record.pageId ?? '') || !Number.isSafeInteger(record.clientSeq) || record.clientSeq <= 0 ||
        !Number.isSafeInteger(record.observedSeq) || !Number.isFinite(record.at) || typeof record.type !== 'string' || record.type.length > 80) {
        throw httpError(400, '操作轨迹缺少编号或时间。');
      }
      record.observedSeq = Math.max(0, Math.min(record.observedSeq, state.seq));
      return env.DB.prepare('INSERT OR IGNORE INTO studio_presentation VALUES (?, ?, ?, ?, ?, ?)').bind(id, record.pageId, record.clientSeq, record.observedSeq, record.at, JSON.stringify(record));
    });
    if (statements.length) await env.DB.batch(statements);
    return json({ received: records.map(record => [record.pageId, record.clientSeq]) });
  }
  if (suffix === '/media' && post) {
    const input = await body(request, 32 * 1024 * 1024);
    const mime = String(input.mime || '').split(';')[0];
    if (!audioTypes.has(mime) || typeof input.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw httpError(400, '录音资源格式无效。');
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > 23 * 1024 * 1024) throw httpError(413, '录音资源超出大小限制。');
    const asset = await writeAsset(env, bytes, mime);
    if (input.hash && input.hash !== asset.hash) throw httpError(409, '录音的哈希校验失败。');
    const at = Number.isFinite(input.at) ? input.at : Date.now();
    const seq = Number.isSafeInteger(input.observedSeq) ? Math.max(0, Math.min(input.observedSeq, state.seq)) : state.seq;
    await env.DB.prepare('INSERT OR IGNORE INTO studio_media VALUES (?, ?, ?, ?, ?)').bind(id, asset.hash, seq, at, JSON.stringify(input.meta ?? {})).run();
    return json(asset);
  }
  if (suffix === '/replay' && read) return json(await replay(env, state, url));
  const draftFile = /^\/draft\/poster\.(svg|png)$/.exec(suffix);
  if (draftFile && read) {
    const draft = state.draft;
    if (!draft || url.searchParams.getAll('draft').some(value => value !== draft.id)) {
      throw httpError(404, '找不到这份待确认稿。');
    }
    const hash = draftFile[1] === 'png' ? draft.pngHash : draft.hash;
    if (!hash) throw httpError(404, '找不到这份待确认稿。');
    return objectResponse(request, env, assetKey(hash), { cache: 'no-store' });
  }
  const file = /^\/versions\/(V\d+)\/poster\.(svg|png)$/.exec(suffix);
  if (file && read) {
    const [, versionId, type] = file;
    const version = state.versions.find(item => item.id === versionId);
    if (!version) throw httpError(404, '找不到这版海报。');
    const filename = `${state.theme.name.replace(/[<>:"/\\|?*]/g, ' ')}_${versionId}.${type}`;
    return objectResponse(request, env, assetKey(type === 'png' ? version.pngHash : version.hash), { download: url.searchParams.get('download') === '1' ? filename : undefined });
  }
  throw httpError(404, '找不到这项工作台操作。');
}

async function api(request, env, ctx, identity, url) {
  const { pathname } = url;
  const read = request.method === 'GET' || request.method === 'HEAD';
  const post = request.method === 'POST';
  if (post && request.headers.has('origin') && request.headers.get('origin') !== url.origin) throw httpError(403, '请从本工作台提交。');
  const defaults = settingsDefaults(env);
  if (pathname === '/api/health' && read) return json({ ok: true, runtime: 'worker', themeId: theme.id });
  if (pathname === '/api/settings') {
    if (!read && !post) throw httpError(405, '此接口只接受 GET 和 POST。');
    return json(await sharedSettingsStatus(request, env, defaults, () => body(request, 16 * 1024)));
  }
  if (pathname === '/api/speech' || pathname === '/api/recognition') {
    const voice = await voiceRequest(request, env, ctx, await readSharedSettings(env, defaults), url);
    if (voice) return voice;
  }
  if (pathname === '/api/sessions') {
    if (post) {
      const input = await body(request);
      const project = projectTheme(input.themeId, input.project);
      const origin = env.STUDIO_PUBLIC_URL ? new URL(env.STUDIO_PUBLIC_URL).origin : url.origin;
      const store = await openSessionStore(env, identity.owner);
      const language = input.language ?? url.searchParams.get('lang');
      const config = await readSharedSettings(env, defaults);
      const state = await engine(store, config).newSession(project, `${origin}${theme.reservationPath}`, !project.custom, language);
      await store.flush();
      return json(localizeSession(state, language), 201);
    }
    if (read) return json({ themes: [theme], sessions: (await listStates(env, identity.owner)).map(state => ({
      id: state.id, startedAt: state.startedAt, updatedAt: state.lastAt,
      theme: { id: state.theme.id, name: state.theme.name, brief: state.theme.brief },
      selectedVersionId: state.selectedVersionId, versionCount: state.versions.length, finalizedVersionId: state.finalizedVersionId
    })) });
  }
  const session = sessionPath.exec(pathname);
  if (session) return sessionRequest(request, env, ctx, defaults, identity, session[1], session[2], url);
  const media = new RegExp(`^/api/media/(${hashPattern})$`).exec(pathname);
  if (read && media) return objectResponse(request, env, assetKey(media[1]));
  const asr = new RegExp(`^/api/asr-source/(${uid})$`).exec(pathname);
  if (read && asr) return objectResponse(request, env, `asr/${asr[1]}`, { expires: true });
  throw httpError(404, '这个工作台接口不存在。');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const identity = visitor(request, url);
    try {
      if (url.pathname.startsWith('/api/')) return withCookie(await api(request, env, ctx, identity, url), identity);
      const staticResponse = await serveStatic(request, env);
      if (!staticResponse) return json({ error: '找不到这个页面。' }, 404);
      return staticResponse.headers.get('content-type')?.includes('text/html') ? withCookie(staticResponse, identity) : staticResponse;
    } catch (error) {
      if (!error.statusCode) console.error('Sites Worker 请求失败', error.message);
      return json({ error: error.statusCode ? error.message : '工作台暂时无法完成这个操作。' }, error.statusCode ?? 500);
    }
  }
};
