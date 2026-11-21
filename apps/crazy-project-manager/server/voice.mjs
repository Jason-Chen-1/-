import WebSocket, { WebSocketServer } from 'ws';
import { settingsDefaults } from './settings.mjs';
import {
  activeSpeechRoles, createSpeechCache, readSpeechInput,
  speechBlockReason, speechProblem, speechTimeout,
} from './speech-provider.mjs';
import {
  createStreamingRecognition, recognitionHandshakeTimeout, recognitionUpgradeError, streamingASRProvider,
  recognitionFrameLimit,
} from './streaming-asr.mjs';

export { handleVolcengineASR } from './volcengine-asr.mjs';

const defaultSpeech = createSpeechCache();
const speechByStore = new WeakMap();

function synthesisFor(scope) {
  if (!scope) return defaultSpeech;
  let speech = speechByStore.get(scope);
  if (!speech) {
    speech = createSpeechCache();
    speechByStore.set(scope, speech);
  }
  return speech;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('语音请求过长。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handleVoice(req, res, url, { storeMedia, speechCache, getSettings = settingsDefaults } = {}) {
  if (url.pathname !== '/api/speech') return false;
  const { tts: config, asr } = getSettings();
  const roles = activeSpeechRoles(config);
  if (req.method === 'GET') {
    const asrStreaming = streamingASRProvider(asr);
    sendJson(res, 200, {
      roles, synthesis: roles.length ? config.mode : 'local', asr: asrStreaming === 'fish', asrMode: asr.mode,
      ...(asrStreaming ? { asrStreaming } : {}),
    });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '此接口只接受 GET 和 POST。' });
    return true;
  }
  let input;
  try {
    input = readSpeechInput(await readJson(req));
  } catch {
    sendJson(res, 400, speechProblem('invalid-input'));
    return true;
  }
  const reason = speechBlockReason(config, input.role);
  if (reason) {
    sendJson(res, 503, speechProblem(reason));
    return true;
  }
  const request = new AbortController();
  const cancel = () => request.abort();
  res.once('close', cancel);
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(speechTimeout)]);
    const speech = synthesisFor(speechCache ?? storeMedia);
    const { audio, asset } = await speech(input, config, signal, {
      persistent: speechCache,
      storeMedia: storeMedia && ((bytes, mime) => storeMedia(Buffer.from(bytes), mime)),
    });
    if (res.destroyed) return true;
    signal.throwIfAborted();
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store',
      'X-Voice-Provider': config.mode,
      ...(asset ? { 'X-Media-Hash': asset.hash, 'X-Media-Url': asset.url } : {}),
    });
    res.end(audio);
  } catch (error) {
    if (!res.destroyed) {
      const timedOut = error?.name === 'TimeoutError';
      sendJson(res, timedOut ? 504 : 502, speechProblem(timedOut ? 'timeout' : 'unavailable'));
    }
  } finally {
    res.off('close', cancel);
  }
  return true;
}

function connectRecognitionSocket({ url, headers }, { receive, disconnected, signal }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: recognitionHandshakeTimeout, maxPayload: 1024 * 1024 });
    let opened = false;
    const cancel = () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    };
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('error', error => {
      if (opened) disconnected();
      else reject(error);
    });
    socket.on('close', () => {
      signal.removeEventListener('abort', cancel);
      if (opened) disconnected();
      else reject(new Error('ASR socket closed before opening'));
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      reject(recognitionUpgradeError(response.statusCode, response.headers['x-tt-logid']));
      cancel();
    });
    socket.on('message', (data, binary) => { if (binary) receive(data); });
    socket.once('open', () => {
      opened = true;
      resolve({
        send(bytes) {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512 * 1024) {
            throw new Error('ASR socket cannot accept more audio');
          }
          socket.send(bytes);
        },
      });
    });
    if (signal.aborted) cancel();
  });
}

export function attachVoiceSocket(server, {
  getSettings = settingsDefaults,
  resourceId = process.env.VOLCENGINE_STREAM_ASR_RESOURCE_ID,
} = {}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: recognitionFrameLimit });
  server.on('upgrade', (req, socket, head) => {
    let config;
    try {
      const url = new URL(req.url, 'http://local');
      config = getSettings().asr;
      if (url.pathname !== '/api/recognition' || !streamingASRProvider(config)) return socket.destroy();
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return socket.destroy();
      }
    } catch {
      return socket.destroy();
    }
    sockets.handleUpgrade(req, socket, head, webSocket => sockets.emit('connection', webSocket, config));
  });
  sockets.on('connection', (socket, config) => {
    const recognition = createStreamingRecognition(config, {
      connect: connectRecognitionSocket, resourceId,
      emit(event) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) socket.close();
      },
    });
    socket.on('message', (data, binary) => recognition.receive(binary ? data : data.toString(), binary));
    socket.on('close', recognition.close);
    socket.on('error', recognition.close);
  });
  return sockets;
}
