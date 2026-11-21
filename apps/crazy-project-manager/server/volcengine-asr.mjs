import { encodeBase64, isEnglishVoice, joinBytes, voiceError as httpError } from './voice-bytes.mjs';

const standardResource = 'volc.seedasr.auc';
const flashResource = 'volc.bigasr.auc_turbo';
const standardResources = new Set([standardResource, 'volc.bigasr.auc']);
const audioLimit = 2 * 1024 * 1024;
const acceptedFormats = new Set(['wav', 'mp3', 'ogg', 'spx', 'amr', 'aac', 'm4a']);
const completed = '20000000';
const pendingCodes = new Set(['20000001', '20000002']);
const silent = '20000003';
const decoder = new TextDecoder();

export const recognizesVolcengine = config => Boolean(config?.key && config.url &&
  ['volcengine', 'volcengine-flash'].includes(config.mode));
export const volcengineASRTimeout = mode => mode === 'volcengine-flash' ? 15000 : 28000;
export const volcengineAudioLimit = mime => mime === 'application/json' ? 8192 : audioLimit;

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw httpError(413, '这段录音超过工作台允许的大小。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '这段录音超过工作台允许的大小。');
    chunks.push(chunk);
  }
  return joinBytes(chunks, size);
}

function checkWav(bytes) {
  const invalid = () => httpError(400, '请提交 16 kHz、16 位单声道 PCM WAV 录音。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = offset => decoder.decode(bytes.subarray(offset, offset + 4));
  if (bytes.length < 46 || label(0) !== 'RIFF' || label(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) {
    throw invalid();
  }

  let format = false;
  let samples = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = label(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    offset = start + size + (size % 2);
    if (offset > bytes.length) throw invalid();
    if (type === 'fmt ') {
      format = size >= 16 && view.getUint16(start, true) === 1 &&
        view.getUint16(start + 2, true) === 1 && view.getUint32(start + 4, true) === 16000 &&
        view.getUint16(start + 12, true) === 2 && view.getUint16(start + 14, true) === 16;
    } else if (type === 'data') {
      samples = size > 0 && size % 2 === 0;
    }
  }
  if (!format || !samples) throw invalid();
}

function publicAudioUrl(value) {
  if (!value || String(value).length > 4096) throw httpError(400, '请提供公网可访问的音频链接。');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, '请提供有效的音频链接。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const [first, second] = host.split('.').map(Number);
  const privateIP = /^\d+(?:\.\d+){3}$/.test(host)
    ? first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) ||
      (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127)
    : host.includes(':') && /^(?:::|f[cd]|fe[89ab]|ff)/i.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.hash || host === 'localhost' || host.endsWith('.localhost') || privateIP) {
    throw httpError(400, '请提供公网可访问的音频链接。');
  }
  return url;
}

async function getAudio(mime, bytes, { flash, language, makeAudioUrl, signal }) {
  if (mime === 'application/json') {
    let input;
    try { input = JSON.parse(decoder.decode(bytes)); } catch { throw httpError(400, '请提交有效的音频链接。'); }
    const url = publicAudioUrl(input?.audioUrl);
    const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    const format = input?.format ?? extension;
    if (!acceptedFormats.has(format)) throw httpError(400, '请指定支持的音频格式，例如 wav 或 mp3。');
    return { url: url.href, format, language };
  }
  if (mime !== 'audio/wav' && mime !== 'audio/x-wav') {
    throw httpError(415, '请提交 WAV 录音或音频链接。');
  }
  checkWav(bytes);
  signal.throwIfAborted();
  const audio = flash ? { data: encodeBase64(bytes) } : {};
  if (!flash) {
    const url = await makeAudioUrl?.(bytes, 'audio/wav');
    if (!url) throw httpError(422, '火山标准版需要公网可访问的录音地址。');
    audio.url = publicAudioUrl(url).href;
  }
  return { ...audio, format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1, language };
}

function validateResource(config, flash) {
  const resource = config.resourceId || (flash ? flashResource : standardResource);
  if (flash ? resource !== flashResource : !standardResources.has(resource)) {
    throw httpError(422, '火山识别资源 ID 与所选版本不匹配。');
  }
  return resource;
}

function queryEndpoint(config) {
  if (config.queryUrl) return config.queryUrl;
  const url = new URL(config.url);
  if (!/\/submit\/?$/.test(url.pathname)) throw httpError(422, '请配置火山标准版的查询接口。');
  url.pathname = url.pathname.replace(/\/submit\/?$/, '/query');
  return url.href;
}

async function requestASR(url, headers, body, signal) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw httpError(502, '火山语音识别服务暂不可用。');
  }
  return response;
}

async function getResult(response, { allowPending = false } = {}) {
  const code = response.headers.get('x-api-status-code');
  if (code === completed) {
    const result = await response.json();
    const text = typeof result.result?.text === 'string' ? result.result.text.trim() : '';
    if (text) return text.slice(0, 2000);
    throw httpError(422, '这次录音里没有识别到可用的语音。');
  }
  await response.body?.cancel();
  if (allowPending && pendingCodes.has(code)) return null;
  if (code === silent) throw httpError(422, '这次录音里没有识别到可用的语音。');
  throw httpError(502, '火山语音识别未返回结果。');
}

function waitForPoll(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1000);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

async function transcribe(config, audio, flash, resource, signal) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': config.key,
    'X-Api-Resource-Id': resource,
    'X-Api-Request-Id': crypto.randomUUID(),
  };
  const payload = {
    user: { uid: 'crazy-project-manager' },
    audio,
    request: { model_name: 'bigmodel' },
  };
  const query = flash ? null : queryEndpoint(config);
  const response = await requestASR(config.url, { ...headers, 'X-Api-Sequence': '-1' }, payload, signal);
  if (flash) return getResult(response);
  const code = response.headers.get('x-api-status-code');
  await response.body?.cancel();
  if (code !== completed) throw httpError(502, '火山标准版未接收这段录音。');
  for (;;) {
    const progress = await requestASR(query, headers, {}, signal);
    const text = await getResult(progress, { allowPending: true });
    if (text) return text;
    await waitForPoll(signal);
  }
}

export async function recognizeVolcengine(config, mime, bytes, { language, makeAudioUrl, signal }) {
  if (!recognizesVolcengine(config)) throw httpError(503, '火山语音识别尚未配置。');
  const flash = config.mode === 'volcengine-flash';
  const resource = validateResource(config, flash);
  const audio = await getAudio(mime, bytes, {
    flash, language: isEnglishVoice(language) ? 'en-US' : 'zh-CN', makeAudioUrl, signal,
  });
  const text = await transcribe(config, audio, flash, resource, signal);
  signal.throwIfAborted();
  return { text, provider: config.mode };
}

export async function handleVolcengineASR(req, res, url, { getSettings, makeAudioUrl } = {}) {
  if (url.pathname !== '/api/recognition') return false;
  if (req.method !== 'POST') {
    reply(res, 405, { error: '请使用 POST 提交录音。' });
    return true;
  }
  const config = getSettings?.().asr;
  if (config?.mode === 'volcengine-sentence') {
    req.resume();
    reply(res, 405, { error: '豆包一句话识别使用工作台的 WebSocket 按住录音接口。' });
    return true;
  }
  if (!recognizesVolcengine(config)) {
    req.resume();
    reply(res, 503, { error: '火山语音识别尚未配置。' });
    return true;
  }
  const client = new AbortController();
  const cancel = () => client.abort();
  const deadline = AbortSignal.timeout(volcengineASRTimeout(config.mode));
  const signal = AbortSignal.any([client.signal, deadline]);
  res.once('close', cancel);
  try {
    const mime = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const bytes = await readBody(req, volcengineAudioLimit(mime));
    const transcript = await recognizeVolcengine(config, mime, bytes, {
      language: req.headers['content-language'], makeAudioUrl, signal,
    });
    reply(res, 200, transcript);
  } catch (error) {
    if (!res.destroyed && !client.signal.aborted) {
      if (deadline.aborted) reply(res, 504, { error: '火山识别暂未完成，可以直接打字。' });
      else reply(res, error.statusCode ?? 502, { error: error.statusCode ? error.message : '火山语音识别暂不可用。' });
    }
  } finally {
    res.off('close', cancel);
  }
  return true;
}
