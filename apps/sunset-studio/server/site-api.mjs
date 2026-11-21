import {adminAccess} from './admin.mjs';
import {runMeeting, personas, speechInstructions} from './agents.mjs';
import {runTurn} from './continuous.mjs';
import {createModelClient, modelDefaults, modelStatus, updatedModel} from './model-provider.mjs';
import {fishDefaults, fishSpeech, fishStatus, updatedFish} from './fish-provider.mjs';
import {createSearch} from './search-core.mjs';
import {requestErrorMessage} from './network-errors.mjs';
import {restore} from '../public/model.js';
import {sanitizeArtboard} from '../public/design-schema.js';

const ADMIN_WRITES = new Set(['/api/config', '/api/disconnect', '/api/test', '/api/fish/config', '/api/fish/disconnect', '/api/fish/cast']);
const USE_ROUTES = new Set(['/api/turn', '/api/meeting', '/api/speech', '/api/fish/speech']);
const ROLES = ['rick', 'june', 'chad', 'user'];
const MODES = ['create', 'review', 'debate', 'settle', 'final'];
const API_HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers: {...API_HEADERS, ...headers}});
const audio = response => new Response(response.body, {headers: {...API_HEADERS, 'Content-Type': 'audio/mpeg'}});

async function readJson(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) throw new ApiError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let decoded = '';
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError(413, 'Request is too large.');
      }
      decoded += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse((decoded + decoder.decode()) || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'Expected a JSON object.');
  return data;
}

function streamEvents(request, run, cleanError, heartbeat = false) {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const emit = event => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      const timer = heartbeat ? setInterval(() => emit({type: 'heartbeat'}), 10000) : null;
      void (async () => {
        try { await run(emit, signal); }
        catch (error) { emit({type: 'error', error: cleanError(error)}); }
        finally {
          clearInterval(timer);
          if (!abort.signal.aborted) controller.close();
        }
      })();
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, {headers: {...API_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no'}});
}

function meetingData(data, maximum, defaultMode) {
  const message = String(data.message || '').trim().slice(0, maximum);
  if (!message) throw new ApiError(400, 'Give the studio an initial brief.');
  const design = restore(data.design);
  design.artboard = sanitizeArtboard(data.design?.artboard);
  const history = (Array.isArray(data.history) ? data.history : []).slice(-24).filter(Boolean).map(item => ({
    who: ROLES.includes(item.who) ? item.who : 'user',
    text: String(item.text || '').slice(0, 1200), decision: String(item.decision || '').slice(0, 300),
  }));
  return {message, design, history, mode: MODES.includes(data.mode) ? data.mode : defaultMode};
}

function createLimit(now) {
  const counts = new Map();
  let minute;
  return (request, operation, maximum, cost = 1) => {
    const current = Math.floor(now() / 60000);
    if (current !== minute) { counts.clear(); minute = current; }
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip && operation !== 'unlock') return;
    const key = `${operation}:${ip || ''}`;
    const count = (counts.get(key) || 0) + cost;
    if (count > maximum || (!counts.has(key) && counts.size >= 4096)) {
      throw new ApiError(429, '请求较多，请稍后再试。');
    }
    counts.set(key, count);
  };
}

export function createStudioApi({getStore, fetchImpl = fetch, allowLocalProvider = false, now = Date.now}) {
  const {upstream, complete} = createModelClient(fetchImpl);
  const search = createSearch({fetchImpl, now});
  const limit = createLimit(now);

  return async function studioApi(request, env = {}) {
    const url = new URL(request.url);
    const route = url.pathname;
    const origin = request.headers.get('Origin');
    const access = adminAccess(request, env, now);
    let privateKey = '';
    const cleanError = error => {
      let message = requestErrorMessage(error);
      if (privateKey) message = message.replaceAll(privateKey, '[redacted]');
      return message.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '[redacted]').slice(0, 350);
    };
    const save = async (store, kind, revision, settings) => {
      let written;
      try { written = await store.write(kind, revision, settings); }
      catch { throw new ApiError(503, '配置存储暂时不可用，请重试。'); }
      if (!written) throw new ApiError(409, '配置已更新，请重新打开设置。');
    };
    const read = async (store, kind) => {
      try { return await store.read(kind); }
      catch { throw new ApiError(503, '配置存储暂时不可用，请重试。'); }
    };

    try {
      if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        throw new ApiError(403, 'Cross-origin requests are not allowed.');
      }
      if (request.method === 'GET' && route === '/api/admin/status') {
        return json({available: access.enabled, unlocked: await access.unlocked()});
      }
      const getRoute = request.method === 'GET' && ['/api/status', '/api/fish/status', '/api/search'].includes(route);
      if (!getRoute) {
        if (request.method !== 'POST') throw new ApiError(405, 'Use a same-origin JSON POST.');
        if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new ApiError(415, 'Use application/json.');
        }
        if (route.startsWith('/api/admin/') || ADMIN_WRITES.has(route)) {
          if (origin !== url.origin) throw new ApiError(403, '请在本站打开 API 设置。');
          if (route === '/api/admin/lock') return json({unlocked: false}, 200, {'Set-Cookie': access.lock()});
          if (route === '/api/admin/unlock') {
            if (!access.enabled) throw new ApiError(503, '管理员验证暂时不可用。');
            limit(request, 'unlock', 16);
            const {key} = await readJson(request, 4096);
            const cookie = await access.unlock(key);
            if (!cookie) throw new ApiError(401, '管理员 Key 不正确。');
            return json({unlocked: true}, 200, {'Set-Cookie': cookie});
          }
          if (!await access.unlocked()) throw new ApiError(401, '请输入管理员 Key 解锁 API 设置。');
        }
        if (!ADMIN_WRITES.has(route) && !USE_ROUTES.has(route)) throw new ApiError(404, 'Unknown API route.');
      }

      const store = getStore(env);
      if (route.startsWith('/api/fish/')) {
        const {revision, value} = await read(store, 'fish');
        const fish = value ?? fishDefaults;
        privateKey = fish.apiKey;
        if (route === '/api/fish/status') return json(fishStatus(fish, await access.unlocked()));
        if (route === '/api/fish/disconnect') {
          const stopped = {...fish, apiKey: '', enabled: false};
          await save(store, 'fish', revision, stopped);
          return json(fishStatus(stopped, true));
        }
        const data = await readJson(request, 20000);
        if (route === '/api/fish/config' || route === '/api/fish/cast') {
          const updated = updatedFish(route.endsWith('/cast') ? {enabled: true} : data, fish);
          await save(store, 'fish', revision, updated);
          return json(fishStatus(updated, true));
        }
        if (!fish.apiKey || !fish.enabled) throw new ApiError(409, 'Fish Audio 配音尚未配置。');
        limit(request, 'speech', 48);
        return audio(await fishSpeech(fetchImpl, fish, data, request.signal));
      }

      const {revision, value} = await read(store, 'model');
      const config = value ?? modelDefaults;
      privateKey = config.apiKey;
      if (route === '/api/status') return json(modelStatus(config, await access.unlocked()));
      if (route === '/api/search') {
        limit(request, 'search', 24);
        return json(await search(url.searchParams.get('q'), {signal: request.signal, config}));
      }
      if (route === '/api/disconnect') {
        const stopped = {...config, apiKey: '', model: '', verified: false};
        await save(store, 'model', revision, stopped);
        return json(modelStatus(stopped, true));
      }
      if (route === '/api/config') {
        const data = await readJson(request, 20000);
        const updated = updatedModel(data, config, allowLocalProvider);
        await save(store, 'model', revision, updated);
        return json(modelStatus(updated, true));
      }
      if (!config.apiKey || !config.model) throw new ApiError(409, '在线模型尚未配置，可使用离线演示。');
      if (route === '/api/test') {
        const {verified} = config;
        if (verified) await save(store, 'model', revision, {...config, verified: false});
        await complete(config, [
          {role: 'system', content: 'Reply only with JSON: {"connected":true}.'},
          {role: 'user', content: 'Connection test.'},
        ], request.signal);
        await save(store, 'model', revision + Number(verified), {...config, verified: true});
        return json({ok: true, model: config.model, verified: true});
      }

      const data = await readJson(request, route === '/api/turn' || route === '/api/meeting' ? 1500000 : 20000);
      if (route === '/api/speech') {
        const input = String(data.text || '').slice(0, 1800);
        const who = Object.hasOwn(personas, data.who) ? data.who : 'rick';
        if (!input) throw new ApiError(400, 'No speech text.');
        limit(request, 'speech', 48);
        const payload = {model: config.ttsModel, input, voice: personas[who].voice, response_format: 'mp3'};
        if (/^tts-1/.test(config.ttsModel)) payload.voice = {rick: 'onyx', june: 'nova', chad: 'ash'}[who];
        else payload.instructions = speechInstructions(who, String(data.emotion || 'amused').slice(0, 50));
        return audio(await upstream(config, '/audio/speech', payload, request.signal));
      }

      const shared = {config, complete, search};
      if (route === '/api/meeting') {
        const meeting = meetingData(data, 6000, 'create');
        limit(request, 'turn', 24, meeting.mode === 'debate' ? 6 : 3);
        return streamEvents(request, (emit, signal) => runMeeting({...shared, ...meeting, signal, emit}), cleanError, true);
      }
      const turn = meetingData(data, 10000, 'review');
      const image = typeof data.image === 'string' ? data.image : '';
      if (image.length > 1000000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image)) {
        throw new ApiError(400, 'A current poster screenshot is required.');
      }
      const who = Object.hasOwn(personas, data.who) ? data.who : 'chad';
      const step = Math.max(0, Math.min(10000, Math.floor(Number(data.step) || 0)));
      limit(request, 'turn', 24);
      const args = {...shared, ...turn, image, who, step};
      if (request.headers.get('Accept')?.includes('application/x-ndjson')) {
        return streamEvents(request, async (emit, signal) => emit(await runTurn({...args, signal, onResearch: emit})), cleanError);
      }
      return json(await runTurn({...args, signal: request.signal}));
    } catch (error) {
      return json({error: cleanError(error)}, error instanceof ApiError ? error.status : 400,
        error?.status === 429 ? {'Retry-After': '60'} : {});
    }
  };
}
