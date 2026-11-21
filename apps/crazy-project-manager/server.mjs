import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDialogueModel } from './server/dialogue-model.mjs';
import { createDesignerModel } from './server/designer-model.mjs';
import { createSessions, publicState } from './server/sessions.mjs';
import { localizeEvent, localizeReplaySubtitles, localizeSession, localizedResponse } from './server/session-language.mjs';
import { roleLanguage } from './server/role-language.mjs';
import { httpError, openStore } from './server/storage.mjs';
import { theme } from './server/domain.mjs';
import * as poster from './server/poster-render.mjs';
import { projectTheme } from './server/project-theme.mjs';
import { createSettings } from './server/settings.mjs';
import { activeAgent } from './server/runtime-config.mjs';
import * as voice from './server/voice.mjs';

const project = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(project, 'dist');
const clientBuild = path.join(dist, 'client');
const frontendSource = path.join(project, 'frontend', 'src');
const workbenchFiles = new Set([
  'workbench-entry.js', 'workbench.js', 'workbench-sheets.js', 'workbench.css', 'manga-workbench.css',
  'performance.js', 'background-music.js', 'performance.css', 'microphone.js', 'mandarin-voices.js', 'recognition-worklet.js',
  'replay.js', 'replay.css', 'replay-player.js'
]);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
const allowedAudio = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/x-wav', 'video/webm']);
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };

function json(res, code, data) {
  res.writeHead(code, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function jsonBody(req, { limit = 128 * 1024 } = {}) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw httpError(413, '这次提交的数据超出大小限制。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object') throw new Error('invalid object');
    return data;
  } catch {
    throw httpError(400, '提交内容不是有效的 JSON。');
  }
}

function streamFile(req, res, filename, size, mime, { download, cache = 'no-cache' } = {}) {
  const headers = { ...securityHeaders, 'Content-Type': mime, 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      status = 206;
    }
    if (status !== 206 || start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD' || size === 0) return res.end();
  const file = createReadStream(filename, { start, end });
  file.on('error', () => res.destroy());
  res.on('close', () => file.destroy());
  file.pipe(res);
}

function replayBundle(store, state, requestedSeq, requestedLanguage) {
  const untilSeq = Math.max(0, Math.min(Number.isSafeInteger(requestedSeq) ? requestedSeq : state.seq, state.seq));
  const sealedAt = Date.now() + 80;
  const language = roleLanguage(requestedLanguage ?? state.language);
  const events = store.events(state.id, 0, untilSeq).map(event => localizeEvent(event, language));
  const snapshots = store.snapshots(state.id, untilSeq);
  const presentation = store.presentation(state.id, untilSeq, sealedAt);
  const media = store.media(state.id, untilSeq, sealedAt);
  const referenced = new Set();
  const assetsByHash = {};
  const missing = [];
  const versions = events.filter(event => event.type === 'version').map(event => event.data.version);
  for (const version of versions) {
    for (const hash of [version.hash, version.pngHash, version.uploadHash, ...(version.assetHashes ?? [])]) if (hash) referenced.add(hash);
  }
  for (const { hash } of media) referenced.add(hash);
  for (const record of presentation) {
    if (record.type !== 'audio-start' && record.type !== 'recording-saved') continue;
    if (/^[a-f0-9]{64}$/.test(record.data?.hash ?? '')) referenced.add(record.data.hash);
  }
  for (const hash of referenced) {
    const asset = store.asset(hash, { verify: true });
    if (asset) assetsByHash[hash] = { url: asset.url, hash, mime: asset.mime, bytes: asset.bytes };
    else missing.push(hash);
  }
  return {
    format: 'crazy-project-manager/replay', version: 1,
    animation: state.appearance ?? (presentation.some(record => record.type === 'ui.ready' && record.data?.appearance === 'manga-2') ? 'manga-2' : 'studio-1'),
    sessionId: state.id, theme: state.theme, language, startedAt: state.startedAt, untilSeq, sealedAt,
    versions, events, snapshots, presentation: localizeReplaySubtitles(presentation, events), media, assets: assetsByHash, missing
  };
}

function prepareRecords(records, state) {
  if (!Array.isArray(records) || records.length > 200) throw httpError(400, '操作轨迹批次无效。');
  return records.map(record => {
    if (!record || !/^[\w-]{1,96}$/.test(record.pageId ?? '') ||
      !Number.isSafeInteger(record.clientSeq) || record.clientSeq <= 0 ||
      !Number.isSafeInteger(record.observedSeq) || !Number.isFinite(record.at) ||
      typeof record.type !== 'string' || record.type.length > 80) throw httpError(400, '操作轨迹缺少编号或时间。');
    return { ...record, observedSeq: Math.max(0, Math.min(record.observedSeq, state.seq)) };
  });
}

async function saveRecording(req, res, store, state) {
  const input = await jsonBody(req, { limit: 32 * 1024 * 1024 });
  const mime = String(input.mime || '').split(';')[0];
  if (!allowedAudio.has(mime) || typeof input.data !== 'string' || !/^[\w+/]+={0,2}$/.test(input.data)) {
    throw httpError(400, '录音资源格式无效。');
  }
  const content = Buffer.from(input.data, 'base64');
  if (!content.length || content.length > 23 * 1024 * 1024) throw httpError(413, '录音资源超出大小限制。');
  const asset = store.saveAsset(content, mime);
  if (input.hash && input.hash !== asset.hash) throw httpError(409, '录音的哈希校验失败。');
  const at = Number.isFinite(input.at) ? input.at : Date.now();
  const observedSeq = Number.isSafeInteger(input.observedSeq) ? Math.min(state.seq, Math.max(0, input.observedSeq)) : state.seq;
  store.attachMedia(state.id, asset.hash, observedSeq, at, input.meta ?? {});
  json(res, 200, asset);
}

export function createStudioServer({
  dataDirectory = process.env.STUDIO_DATA_DIR || path.join(project, '.studio-data'),
  envFile = path.join(dataDirectory, '.env'),
  settingsEnv = process.env,
  publicURL = process.env.STUDIO_PUBLIC_URL,
  stepMs,
  dialogueModel,
  voiceEnabled = true
} = {}) {
  const store = openStore(dataDirectory);
  const settings = createSettings(envFile, settingsEnv);
  const channels = new Map();
  const channelLanguages = new WeakMap();
  const asrSources = new Map();
  let configuredOrigin = null;
  if (publicURL) {
    const url = new URL(publicURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('STUDIO_PUBLIC_URL 必须是网站 HTTP(S) 地址');
    configuredOrigin = url.origin;
  }

  const push = (res, state, events) => {
    if (res.destroyed) return;
    if (res.writableLength > 512 * 1024) return res.destroy();
    const update = localizedResponse({ state, events }, channelLanguages.get(res));
    res.write(`id: ${state.seq}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`);
  };
  function publishSpeech(type, chunk) {
    const event = `event: ${type}\ndata: ${JSON.stringify(chunk)}\n\n`;
    for (const response of channels.get(chunk.sessionId) ?? []) {
      if (response.destroyed) continue;
      if (response.writableLength > 512 * 1024) response.destroy();
      else response.write(event);
    }
  }
  const sessions = createSessions(store, {
    poster, stepMs, getDialogueModel: () => {
      if (dialogueModel !== undefined) return dialogueModel;
      const { text, vision } = activeAgent(settings.read());
      return createDialogueModel(text, vision);
    },
    getDesignerModel: () => createDesignerModel(activeAgent(settings.read()).text),
    getImageConfig: () => settings.read().image,
    publish({ state, events }) {
      for (const response of channels.get(state.id) ?? []) push(response, state, events);
    },
    onMeetingChunk: chunk => publishSpeech('meeting-speech', chunk),
    onDesignerSpeech: chunk => publishSpeech('designer-speech', chunk)
  });
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      if (!error.statusCode) console.error('请求失败', error.message);
      json(res, error.statusCode ?? 500, { error: error.statusCode ? error.message : '工作台暂时无法完成这个操作。' });
    });
  });

  async function reservationAddress(req, verify = true) {
    const listener = server.address();
    const loopback = listener.address === '::' ? '[::1]' : listener.address === '0.0.0.0' ? '127.0.0.1' :
      listener.family === 'IPv6' ? `[${listener.address}]` : listener.address;
    const self = `http://${loopback}:${listener.port}`;
    const host = req.headers.host && /^[\w.\-\[\]:]+$/.test(req.headers.host) ? req.headers.host : new URL(self).host;
    const reservationUrl = `${configuredOrigin ?? `http://${host}`}${theme.reservationPath}`;
    if (!verify) return { reservationUrl, verified: false };
    // Only a configured public address or the actual listener is probed. The Host header never selects a fetch target.
    const target = `${configuredOrigin ?? self}${theme.reservationPath}`;
    try {
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(1200) });
      const verified = response.ok && (await response.text()).includes('<meta name="studio-reservation" content="museum-night">');
      return { reservationUrl, verified };
    } catch {
      return { reservationUrl, verified: false };
    }
  }

  function subscribe(req, res, url, state) {
    const header = Number(req.headers['last-event-id']);
    const requested = Number(url.searchParams.get('after'));
    const after = Math.min(state.seq, Math.max(0, Number.isSafeInteger(header) ? header : 0, Number.isSafeInteger(requested) ? requested : 0));
    res.writeHead(200, {
      ...securityHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 800\n\n');
    req.socket.setNoDelay(true);
    const subscribers = channels.get(state.id) ?? new Set();
    subscribers.add(res);
    channels.set(state.id, subscribers);
    channelLanguages.set(res, url.searchParams.get('lang'));
    push(res, publicState(state), store.events(state.id, after, state.seq));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 12500);
    res.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(res);
      if (!subscribers.size) channels.delete(state.id);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://studio.local');
    const { pathname } = url;
    const post = req.method === 'POST';
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (post && req.headers.origin) {
      const sameHost = new URL(req.headers.origin).host === req.headers.host;
      if (!sameHost && req.headers.origin !== configuredOrigin) throw httpError(403, '请从工作台页面提交操作。');
    }
    if (pathname === '/api/health' && read) return json(res, 200, { ok: true, themeId: theme.id });
    if (pathname === '/api/settings' && (post || read)) {
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!loopback || !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw httpError(403, '请从本机工作台打开 API 设置。');
      return json(res, 200, post ? settings.update(await jsonBody(req)) : settings.status());
    }
    if (pathname === '/api/speech' && voiceEnabled) {
      return voice.handleVoice(req, res, url, {
        storeMedia: store.saveAsset, speechCache: store.speechCache, getSettings: settings.read,
      });
    }
    if (pathname === '/api/recognition' && post && voiceEnabled) {
      return voice.handleVolcengineASR(req, res, url, {
        getSettings: settings.read,
        makeAudioUrl(bytes, mime) {
          if (!configuredOrigin?.startsWith('https://')) {
            throw httpError(422, '火山标准版需要 STUDIO_PUBLIC_URL 指向外网可访问的 HTTPS 工作台，或使用已有的音频链接。');
          }
          const now = Date.now();
          for (const [id, source] of asrSources) if (source.expires <= now) asrSources.delete(id);
          if (asrSources.size >= 16) throw httpError(429, '录音转写任务较多，请稍后再试。');
          const id = globalThis.crypto.randomUUID();
          asrSources.set(id, { bytes, mime, expires: now + 15 * 60 * 1000 });
          return `${configuredOrigin}/api/asr-source/${id}`;
        }
      });
    }
    const asrSource = /^\/api\/asr-source\/([a-f0-9-]{36})$/.exec(pathname);
    if (read && asrSource) {
      const source = asrSources.get(asrSource[1]);
      if (!source || source.expires <= Date.now()) {
        asrSources.delete(asrSource[1]);
        throw httpError(404, '录音链接已过期。');
      }
      res.writeHead(200, { ...securityHeaders, 'Content-Type': source.mime, 'Content-Length': source.bytes.length, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : source.bytes);
    }
    if (pathname === '/api/sessions') {
      if (post) {
        const input = await jsonBody(req);
        const project = projectTheme(input.themeId, input.project);
        const { reservationUrl, verified } = await reservationAddress(req, !project.custom);
        const language = input.language ?? url.searchParams.get('lang');
        return json(res, 201, localizeSession(await sessions.newSession(project, reservationUrl, verified, language), language));
      }
      if (read) return json(res, 200, {
        themes: [theme],
        sessions: store.list().slice(0, 30).map(state => ({
          id: state.id, startedAt: state.startedAt, updatedAt: state.lastAt, theme: { id: state.theme.id, name: state.theme.name, brief: state.theme.brief },
          selectedVersionId: state.selectedVersionId, versionCount: state.versions.length, finalizedVersionId: state.finalizedVersionId
        }))
      });
    }
    const media = /^\/api\/media\/([a-f0-9]{64})$/.exec(pathname);
    if (read && media) {
      const asset = store.asset(media[1]);
      if (!asset) throw httpError(404, '找不到这项回放资源。');
      return streamFile(req, res, asset.filename, asset.bytes, asset.mime, { cache: 'private, max-age=31536000, immutable' });
    }
    const sessionRoute = /^\/api\/sessions\/([a-f0-9-]{36})(.*)$/.exec(pathname);
    if (sessionRoute) {
      const [, id, suffix] = sessionRoute;
      const state = store.require(id);
      const language = url.searchParams.get('lang');
      if (!suffix && read) return json(res, 200, localizeSession(publicState(state), language));
      if (suffix === '/events' && req.method === 'GET') return subscribe(req, res, url, state);
      if (suffix === '/commands' && post) {
        const command = await jsonBody(req, { limit: 12 * 1024 * 1024 });
        const proof = command.type === 'verifyReservation' ? await reservationAddress(req) : undefined;
        const { statusCode, ...result } = sessions.command(id, command, proof);
        return json(res, statusCode ?? 200, localizedResponse(result, language));
      }
      if (suffix === '/presentation' && post) {
        const input = await jsonBody(req, { limit: 1024 * 1024 });
        const records = prepareRecords(input.records, store.require(id));
        return json(res, 200, { received: store.present(id, records) });
      }
      if (suffix === '/media' && post) return saveRecording(req, res, store, state);
      if (suffix === '/replay' && read) {
        const requested = url.searchParams.has('until') ? Number(url.searchParams.get('until')) : undefined;
        return json(res, 200, replayBundle(store, state, requested, language));
      }
      const draftFile = /^\/draft\/poster\.(svg|png)$/.exec(suffix);
      if (read && draftFile) {
        const draft = state.draft;
        if (!draft || url.searchParams.getAll('draft').some(value => value !== draft.id)) {
          throw httpError(404, '找不到这份待确认稿。');
        }
        const hash = draftFile[1] === 'png' ? draft.pngHash : draft.hash;
        const asset = hash && store.asset(hash);
        if (!asset) throw httpError(404, '找不到这份待确认稿。');
        return streamFile(req, res, asset.filename, asset.bytes, asset.mime, { cache: 'no-store' });
      }
      const poster = /^\/versions\/(V\d+)\/poster\.(svg|png)$/.exec(suffix);
      if (read && poster) {
        const [, versionId, kind] = poster;
        const version = state.versions.find(item => item.id === versionId);
        const asset = version && store.asset(kind === 'png' ? version.pngHash : version.hash);
        if (!asset) throw httpError(404, '找不到这版海报。');
        const download = url.searchParams.get('download') === '1' ? `${state.theme.name.replace(/[<>:"/\\|?*]/g, ' ')}_${versionId}.${kind}` : undefined;
        return streamFile(req, res, asset.filename, asset.bytes, asset.mime, { cache: 'private, max-age=31536000, immutable', download });
      }
    }
    if (pathname.startsWith('/api/')) throw httpError(404, '这个工作台接口不存在。');
    if (!read) throw httpError(405, '该地址不接受此类请求。');
    const route = decodeURIComponent(pathname);
    const home = ['/', '/home.html', '/index.html'].includes(route);
    const workbench = ['/workbench', '/workbench.html'].includes(route);
    const clientRoute = home ? '/index.html' : workbench ? '/workbench.html' : route === '/reservation' ? '/reservation.html' : route;
    const candidates = [[clientBuild, clientRoute]];
    if (!home && !workbench) candidates.push([dist, clientRoute]);
    if (route === '/home.css' || route === '/i18n.js') candidates.push([frontendSource, route]);
    if (workbenchFiles.has(route.slice(1))) candidates.push([frontendSource, `/workbench${route}`]);
    for (const [directory, subpath] of candidates) {
      const filename = path.resolve(directory, `.${subpath}`);
      if (!filename.startsWith(directory + path.sep)) break;
      const info = await stat(filename).catch(() => null);
      if (!info?.isFile()) continue;
      const mime = mimeTypes[path.extname(filename)] || 'application/octet-stream';
      return streamFile(req, res, filename, info.size, mime);
    }
    throw httpError(404, '找不到这个页面。');
  }

  const voiceSockets = voiceEnabled && voice.attachVoiceSocket?.(server, { getSettings: settings.read });
  sessions.recover();
  server.once('close', () => {
    sessions.close();
    store.close();
  });
  return {
    server, store,
    async close() {
      sessions.close();
      for (const socket of voiceSockets?.clients ?? []) socket.terminate();
      voiceSockets?.close?.();
      for (const responses of channels.values()) for (const response of responses) response.end();
      if (!server.listening) {
        store.close();
        return;
      }
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await done;
    }
  };
}

function openWindowsBrowser(address) {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', address], { stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.log(`请在浏览器打开 ${address}`));
  browser.unref();
}

export async function startServer({ openBrowser = false } = {}) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const hostName = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const shouldOpen = openBrowser && process.platform === 'win32';
  const studio = createStudioServer({ envFile: path.join(project, '.env') });
  try {
    await new Promise((resolve, reject) => {
      studio.server.once('error', reject);
      studio.server.listen(port, host, resolve);
    });
  } catch (error) {
    await studio.close();
    if (shouldOpen && error.code === 'EADDRINUSE') {
      const address = `http://${hostName}:${port}/`;
      const health = await fetch(new URL('api/health', address), { signal: AbortSignal.timeout(900) })
        .then(response => response.ok && response.json()).catch(() => null);
      if (health?.themeId === theme.id) {
        openWindowsBrowser(address);
        return null;
      }
    }
    throw error;
  }
  const address = `http://${hostName}:${studio.server.address().port}/`;
  console.log(`疯狂的项目经理 · ${address}`);
  process.once('SIGINT', () => studio.close());
  process.once('SIGTERM', () => studio.close());
  if (shouldOpen) openWindowsBrowser(address);
  return studio;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startServer({ openBrowser: process.argv.includes('--open') }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
