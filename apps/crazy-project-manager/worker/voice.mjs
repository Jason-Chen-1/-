import { createHash } from 'node:crypto';
import { joinBytes, voiceError } from '../server/voice-bytes.mjs';
import {
  activeSpeechRoles, createSpeechCache, readSpeechInput,
  speechBlockReason, speechProblem, speechTimeout,
} from '../server/speech-provider.mjs';
import {
  createStreamingRecognition, recognitionHandshakeTimeout, recognitionUpgradeError, streamingASRProvider,
} from '../server/streaming-asr.mjs';
import {
  recognizeVolcengine, recognizesVolcengine, volcengineASRTimeout, volcengineAudioLimit,
} from '../server/volcengine-asr.mjs';
import { assetKey } from './store.mjs';

const noCache = 'no-store';
const speech = createSpeechCache();
const indexKey = key => `speech-cache/v1/${key}`;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': noCache } });
}

async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) {
    throw voiceError(413, '本次语音提交超过大小限制。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw voiceError(413, '本次语音提交超过大小限制。');
    chunks.push(chunk);
  }
  return joinBytes(chunks, size);
}

function speechStorage(bucket) {
  if (!bucket) return undefined;
  return {
    async get(key) {
      const index = await bucket.get(indexKey(key));
      if (index?.size !== 64) return null;
      const hash = await index.text();
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const object = await bucket.get(assetKey(hash));
      if (!object || object.size > 1_280_000 || object.httpMetadata?.contentType !== 'audio/mpeg') return null;
      const audio = new Uint8Array(await object.arrayBuffer());
      if (createHash('sha256').update(audio).digest('hex') !== hash) return null;
      return { audio, asset: { hash, mime: 'audio/mpeg', url: `/api/media/${hash}` } };
    },
    async set(key, asset) {
      await bucket.put(indexKey(key), asset.hash);
    },
  };
}

async function handleSpeech(request, { tts, asr }, { saveMedia, persistent, keepAlive }) {
  const roles = activeSpeechRoles(tts);
  if (request.method === 'GET') {
    const asrStreaming = typeof WebSocketPair === 'undefined' ? null : streamingASRProvider(asr);
    return json({
      roles, synthesis: roles.length ? tts.mode : 'local', asr: asrStreaming === 'fish', asrMode: asr.mode,
      ...(asrStreaming ? { asrStreaming } : {}),
    });
  }
  if (request.method !== 'POST') return json({ error: '此接口只接受 GET 和 POST。' }, 405);
  let input;
  try {
    input = readSpeechInput(JSON.parse(new TextDecoder().decode(await readBytes(request, 4096))));
  } catch (error) {
    return json(speechProblem('invalid-input'), error.statusCode ?? 400);
  }
  const reason = speechBlockReason(tts, input.role);
  if (reason) return json(speechProblem(reason), 503);
  const deadline = AbortSignal.timeout(speechTimeout);
  const signal = AbortSignal.any([request.signal, deadline]);
  try {
    const { audio, asset } = await speech(input, tts, signal, { persistent, storeMedia: saveMedia, keepAlive });
    signal.throwIfAborted();
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg', 'Cache-Control': noCache, 'X-Voice-Provider': tts.mode,
        ...(asset ? { 'X-Media-Hash': asset.hash, 'X-Media-Url': asset.url } : {}),
      },
    });
  } catch (error) {
    const timedOut = deadline.aborted || error?.name === 'TimeoutError';
    return json(speechProblem(timedOut ? 'timeout' : 'unavailable'), timedOut ? 504 : 502);
  }
}

async function handleRecognition(request, asr, makeAudioUrl) {
  if (asr.mode === 'volcengine-sentence') return json({ error: '豆包一句话识别使用工作台的 WebSocket 按住录音接口。' }, 405);
  if (!recognizesVolcengine(asr)) return json({ error: '火山语音识别尚未配置。' }, 503);
  const deadline = AbortSignal.timeout(volcengineASRTimeout(asr.mode));
  const signal = AbortSignal.any([request.signal, deadline]);
  try {
    const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const bytes = await readBytes(request, volcengineAudioLimit(mime));
    return json(await recognizeVolcengine(asr, mime, bytes, {
      language: request.headers.get('content-language'), makeAudioUrl, signal,
    }));
  } catch (error) {
    return deadline.aborted ? json({ error: '火山识别暂未完成，可以直接打字。' }, 504)
      : json({ error: error.statusCode ? error.message : '火山语音识别暂不可用。' }, error.statusCode ?? 502);
  }
}

async function connectRecognitionSocket({ url, headers }, { receive, disconnected, signal }) {
  const endpoint = new URL(url);
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(), recognitionHandshakeTimeout);
  let response;
  try {
    response = await fetch(endpoint, {
      redirect: 'manual', headers: { ...headers, Upgrade: 'websocket' },
      signal: AbortSignal.any([signal, handshake.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
  const socket = response.webSocket;
  if (!socket) {
    void response.body?.cancel().catch(() => {});
    throw recognitionUpgradeError(response.status, response.headers.get('x-tt-logid'));
  }
  socket.binaryType = 'arraybuffer';
  socket.accept();
  const cancel = () => { if (socket.readyState < 2) socket.close(); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  socket.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) receive(new Uint8Array(data));
  });
  socket.addEventListener('error', disconnected);
  socket.addEventListener('close', () => {
    signal.removeEventListener('abort', cancel);
    disconnected();
  });
  return {
    send(bytes) {
      if (socket.readyState !== 1 || socket.bufferedAmount > 512 * 1024) {
        throw new Error('ASR socket cannot accept more audio');
      }
      socket.send(bytes);
    },
  };
}

function handleRecognitionUpgrade(config, resourceId) {
  if (typeof WebSocketPair === 'undefined' || !streamingASRProvider(config)) {
    return json({ error: '实时语音识别尚未配置。' }, 503);
  }
  const [front, browser] = Object.values(new WebSocketPair());
  browser.binaryType = 'arraybuffer';
  browser.accept();
  const recognition = createStreamingRecognition(config, {
    connect: connectRecognitionSocket, resourceId,
    emit(event) {
      if (browser.readyState === 1) browser.send(JSON.stringify(event));
    },
    close() {
      if (browser.readyState < 2) browser.close();
    },
  });
  browser.addEventListener('message', ({ data }) => {
    recognition.receive(data, typeof data !== 'string');
  });
  browser.addEventListener('error', recognition.close);
  browser.addEventListener('close', recognition.close);
  return new Response(null, { status: 101, webSocket: front });
}

export async function workerVoice(request, env, { settings, saveMedia, makeAudioUrl, keepAlive }) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/speech' && url.pathname !== '/api/recognition') return null;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: '请从工作台页面提交语音。' }, 403);
  if (url.pathname === '/api/speech') {
    return handleSpeech(request, settings, { saveMedia, persistent: speechStorage(env.BUCKET), keepAlive });
  }
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    return handleRecognitionUpgrade(settings.asr, env.VOLCENGINE_STREAM_ASR_RESOURCE_ID);
  }
  if (request.method !== 'POST') return json({ error: '请使用 POST 提交录音。' }, 405);
  return handleRecognition(request, settings.asr, makeAudioUrl);
}
