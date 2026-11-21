import { createHash } from 'node:crypto';
import { designerSpeech } from '../shared/designer-speech.mjs';
import { isEnglishVoice, joinBytes } from './voice-bytes.mjs';
import { synthesizeVolcengine, volcengineResourceId } from './volcengine-tts.mjs';

const profiles = {
  zhou: { speed: 0.94, performance: 'low register, dry, decisive, firmly stressed' },
  lin: { speed: 1.07, performance: 'cool low-mid register, clipped and precise, dry and composed' },
  tang: { speed: 1.19, performance: 'energized, rising intonation, quick and assertive' },
  yi: { speed: 1.08, performance: 'young alert voice, bouncy conversational timing' },
};
const emotions = {
  firm: 'firm, downward inflection',
  angry: 'frustrated, sharp emphatic stress',
  sharp: 'short sharp emphasis',
  point: 'precise, clipped',
  urgent: 'urgent, accelerating',
  excited: 'excited, rising pitch',
  ready: 'quick, eager',
  lazy: 'drowsy, muttering, a long pause',
  startled: 'startled gasp, sudden high pitch, then frantic',
  confused: 'puzzled, questioning',
  resume: 'wide awake, quick and apologetic',
  done: 'bright and relieved',
};
const cacheLimit = 12_000_000;
const audioLimit = 1_280_000;
const openRouterFreeModel = 'heygen/heygen-voice-1-turbo:free';
const audioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'audio/x-mp3', 'application/octet-stream']);
const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const mp3SampleRates = [44100, 48000, 32000];
const digest = value => createHash('sha256').update(value).digest('hex');
export const speechTimeout = 15_000;

export function speechBlockReason(config, role) {
  const onlineMode = config.mode === 'fish' ||
    (config.mode === 'openrouter' && config.model === openRouterFreeModel) ||
    (config.mode === 'volcengine' && config.model === volcengineResourceId);
  if (!onlineMode || !config.url) return 'unconfigured';
  if (!config.key) return 'missing-key';
  if (!config.voices?.[role]) return 'missing-voice';
  return null;
}

export function activeSpeechRoles(config) {
  return Object.keys(profiles).filter(role => !speechBlockReason(config, role));
}

const speechMessages = {
  unconfigured: '请在 API 设置中启用外部 TTS 服务。',
  'missing-key': '请在 API 设置中填写 TTS 服务密钥。',
  'missing-voice': '请在 API 设置中为这个角色选择音色。',
  'invalid-input': '需要有效角色和不超过 180 字的台词。',
  timeout: '在线配音超时。',
  unavailable: '在线配音暂不可用。',
};

export function speechProblem(reason) {
  return { reason, error: speechMessages[reason] };
}

export function fishRecognitionContext(language) {
  return {
    terms: isEnglishVoice(language)
      ? ['Night at the Museum', 'Zhou', 'Lin Chi', 'Tang', 'Xiaoyi', 'East Gate', 'reservation']
      : ['夜游美术馆', '未眠美术馆', '周总', '林尺', '阿唐', '小乙', '东门', '免费预约'],
  };
}

export function readSpeechInput(data) {
  const role = data?.role;
  const mood = Object.hasOwn(emotions, data?.mood) ? data.mood : 'neutral';
  const copy = role === 'yi' ? designerSpeech(data?.text) : data?.text;
  const text = typeof copy === 'string'
    ? copy.replace(/\[[^\]]{0,100}\]/g, '').replace(/[\[\]\u0000-\u001f]/g, ' ').trim()
    : '';
  if (!Object.hasOwn(profiles, role) || !text || text.length > 180) {
    throw new Error('请提供四位角色之一和不超过 180 字的台词。');
  }
  return { role, mood, text, language: isEnglishVoice(data?.language) ? 'en' : 'zh-CN' };
}

function isMP3(audio) {
  if (!audio || audio.byteLength < 100 || audio.byteLength > audioLimit) return false;
  let offset = 0;
  if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
    const size = audio.subarray(6, 10);
    if (size.some(byte => byte & 0x80)) return false;
    const footer = audio[3] === 4 && (audio[5] & 0x10) ? 10 : 0;
    offset = 10 + footer + size.reduce((total, byte) => total * 128 + byte, 0);
  }
  if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe6) !== 0xe2) return false;
  const version = (audio[offset + 1] >> 3) & 3;
  if (version === 1) return false;
  const bitrateIndex = audio[offset + 2] >> 4;
  const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
  const sampleRate = mp3SampleRates[(audio[offset + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  if (!bitrate || !sampleRate) return false;
  const padding = (audio[offset + 2] >> 1) & 1;
  const frameSize = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + padding;
  return offset + frameSize <= audio.length;
}

function speechRequest({ role, mood, text, language: locale }, config) {
  const language = isEnglishVoice(locale) ? 'en' : 'zh-CN';
  const profile = profiles[role];
  const speed = mood === 'lazy' ? 0.83 : mood === 'startled' ? 1.19 : profile.speed;
  const direction = [profile.performance, language === 'en' ? 'clear English' : 'clear Mandarin', emotions[mood]]
    .filter(Boolean).join(', ');
  const key = digest(JSON.stringify(['studio-speech-v1', config.mode, new URL(config.url).href, config.model, config.voices[role],
    digest(config.key), role, mood, language, text, speed, direction]));
  return { key, role, mood, text, language, speed, direction };
}

async function synthesizeSpeech(request, config, signal) {
  const { role, text, language, speed, direction } = request;
  if (config.mode === 'volcengine') {
    return synthesizeVolcengine(request, config, signal);
  }
  const router = config.mode === 'openrouter';
  const payload = router ? {
    model: config.model, input: text, voice: config.voices[role], response_format: 'mp3',
  } : {
    text: `[${direction}] ${text}`, reference_id: config.voices[role], language,
    format: 'mp3', mp3_bitrate: 64, latency: 'balanced', temperature: 0.7,
    prosody: { speed, volume: 0, normalize_loudness: true },
  };
  const response = await fetch(config.url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(router ? {} : { model: config.model }),
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok || !response.body) throw new Error('在线配音暂不可用。');
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime && !audioTypes.has(mime)) {
    throw new Error('在线配音返回了其他音频格式。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > audioLimit) throw new Error('在线配音返回了过大的音频。');
    chunks.push(chunk);
  }
  if (size < 100) throw new Error('在线配音未返回可用音频。');
  return joinBytes(chunks, size);
}

function waitForSpeech(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export function createSpeechCache() {
  const cache = new Map();
  const pending = new Map();
  let cachedBytes = 0;

  function cacheVoice(key, result) {
    while (cache.size >= 128 || (cache.size && cachedBytes + result.audio.byteLength > cacheLimit)) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).audio.byteLength;
      cache.delete(oldest);
    }
    cache.set(key, result);
    cachedBytes += result.audio.byteLength;
    return result;
  }

  async function loadOrSynthesize(request, config, { persistent, storeMedia }) {
    const deadline = AbortSignal.timeout(speechTimeout);
    const stored = await Promise.resolve().then(() => persistent?.get(request.key)).catch(() => null);
    if (stored?.asset && isMP3(stored.audio)) return cacheVoice(request.key, stored);
    deadline.throwIfAborted();
    const audio = await synthesizeSpeech(request, config, deadline);
    deadline.throwIfAborted();
    if (!isMP3(audio)) throw new Error('在线配音没有返回有效的 MP3。');
    const asset = await storeMedia?.(audio, 'audio/mpeg');
    const result = { audio, asset };
    if (asset && persistent) {
      try {
        await persistent.set(request.key, asset);
      } catch {
        return result;
      }
    }
    return cacheVoice(request.key, result);
  }

  return function speech(input, config, signal, { persistent, storeMedia, keepAlive } = {}) {
    signal?.throwIfAborted();
    const request = speechRequest(input, config);
    const saved = cache.get(request.key);
    if (saved) {
      cache.delete(request.key);
      cache.set(request.key, saved);
      return saved;
    }
    let operation = pending.get(request.key);
    if (!operation) {
      operation = loadOrSynthesize(request, config, { persistent, storeMedia }).finally(() => pending.delete(request.key));
      pending.set(request.key, operation);
      if (keepAlive) keepAlive(operation.catch(() => {}));
    }
    return waitForSpeech(operation, signal);
  };
}
