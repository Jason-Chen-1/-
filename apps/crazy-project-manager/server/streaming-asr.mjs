import { decode, encode } from '@msgpack/msgpack';
import { fishRecognitionContext } from './speech-provider.mjs';
import { volcengineRecognitionProtocol } from './volcengine-stream-asr.mjs';

export const recognitionFrameLimit = 16 * 1024;
export const recognitionHandshakeTimeout = 6000;
const recordingLimit = 8 * 1024 * 1024;
const fishSampleRates = new Set([8000, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
const errorMessages = {
  network: '语音识别连接失败，可以直接打字。',
  timeout: '语音识别等待超时，可以直接打字。',
  'recording-timeout': '录音已超时，请重新按住录音。',
  'invalid-audio': '录音格式无效，可以直接打字。',
  'no-speech': '没听清这句话，请再说一次或直接打字。',
  'stream-permission': '火山流式语音识别未获授权，请检查 API Key 与流式语音识别 2.0 的开通状态。',
  'provider-refused': '实时语音识别服务拒绝了连接，请检查 API 设置。',
  'incomplete-transcript': '识别服务没有返回最终文本，可以用已识别的草稿继续编辑。',
};

export function streamingASRProvider(config) {
  if (!config?.key) return null;
  if (config.mode === 'fish' && config.url) return 'fish';
  if (['volcengine', 'volcengine-flash', 'volcengine-sentence'].includes(config.mode)) return 'volcengine';
  return null;
}

export function recognitionUpgradeError(status, logId) {
  return Object.assign(new Error('ASR WebSocket upgrade refused'), {
    upstreamStatus: Number.isInteger(status) ? status : undefined,
    logId: typeof logId === 'string' && /^[\w-]{1,96}$/.test(logId) ? logId : undefined,
  });
}

function fishRecognitionProtocol(config, start) {
  return {
    url: config.url,
    headers: { Authorization: `Bearer ${config.key}`, model: 'transcribe-stream-1' },
    start: encode({
      type: 'config',
      audio: { format: 'pcm_s16le', sample_rate: start.sampleRate, channels: 1 },
      turn_detection: { mode: 'manual' },
      results: { drafts: true, ignore_timestamps: true, diarize: false, tag_audio_events: false },
      context: fishRecognitionContext(start.language),
    }),
    audio: (bytes, final) => encode(final ? { type: 'audio_done' } : { type: 'audio', data: bytes }),
    read: decode,
  };
}

export function createStreamingRecognition(config, { connect, emit, close, resourceId }) {
  const provider = streamingASRProvider(config);
  const sentence = config?.mode === 'volcengine-sentence';
  const lifetime = new AbortController();
  const pending = [];
  const committed = [];
  // Volcengine expects 100–200 ms PCM packets. Keep the remainder for its last audio frame.
  const pcm = new Uint8Array(6400);
  let used = 0;
  let size = 0;
  let ready = false;
  let ended = false;
  let finished = false;
  let english = false;
  let degraded = false;
  let draft = '';
  let stable = '';
  let protocol;
  let upstream;
  let setupTimer;
  let finalTimer;
  const recordingTimer = setTimeout(() => fail('recording-timeout'), 70000);

  function terminate(event) {
    if (finished) return;
    finished = true;
    clearTimeout(recordingTimer);
    clearTimeout(setupTimer);
    clearTimeout(finalTimer);
    pending.length = 0;
    try { if (event) emit({ ...event, provider }); } finally {
      lifetime.abort();
      close();
    }
  }

  function fail(code, details) {
    terminate({ type: 'error', code, error: errorMessages[code], ...details });
  }

  function transcript(text) {
    return typeof text === 'string' ? text.trim().slice(0, 2000) : '';
  }

  function reportDraft(value) {
    const text = transcript(value);
    if (text === draft) return;
    draft = text;
    if (!sentence) emit({ type: 'draft', provider, text });
  }

  function finalize(value) {
    const text = transcript(value);
    if (text) terminate({ type: 'final', text });
    else fail(draft ? 'incomplete-transcript' : 'no-speech');
  }

  function send(bytes) {
    if (finished) return;
    try { upstream.send(bytes); } catch { fail('network'); }
  }

  function sendAudio(bytes) {
    if (provider === 'fish') {
      send(protocol.audio(bytes, false));
      return;
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (used === pcm.byteLength) {
        send(protocol.audio(pcm, false));
        used = 0;
      }
      const count = Math.min(bytes.byteLength - offset, pcm.byteLength - used);
      pcm.set(bytes.subarray(offset, offset + count), used);
      used += count;
      offset += count;
    }
  }

  function openForAudio() {
    if (ready) return;
    clearTimeout(setupTimer);
    ready = true;
    emit({ type: 'ready', provider });
    for (const bytes of pending.splice(0)) sendAudio(bytes);
    if (ended) send(protocol.audio(pcm.subarray(0, used), true));
  }

  function receiveUpstream(bytes) {
    if (finished) return;
    let event;
    try { event = protocol.read(bytes); } catch { fail('network'); return; }
    if (!event || typeof event !== 'object') return;
    if (provider === 'fish') {
      if (event.type === 'session_started') openForAudio();
      if (event.type === 'draft') {
        reportDraft([...committed, transcript(event.text)].filter(Boolean).join(english ? ' ' : ''));
      }
      if (event.type === 'committed' && event.user_turn !== false) {
        const text = transcript(event.text);
        if (text) committed.push(text);
        degraded ||= event.degraded === true;
        reportDraft(committed.join(english ? ' ' : ''));
      }
      if (event.type === 'session_done' && ended) {
        if (degraded) fail('incomplete-transcript');
        else finalize(committed.join(english ? ' ' : ''));
      }
      if (event.type === 'error' && !event.recoverable) {
        fail('provider-refused', Number.isInteger(event.code) ? { upstreamCode: event.code } : undefined);
      }
      return;
    }
    if (event.errorCode !== undefined) {
      const code = { 45000002: 'no-speech', 45000081: 'timeout', 45000151: 'invalid-audio' }[event.errorCode];
      fail(code ?? 'provider-refused', { upstreamCode: event.errorCode });
      return;
    }
    if (event.ready) openForAudio();
    if (event.draft !== undefined && (!event.done || event.draft.trim())) {
      reportDraft(event.draft);
      if (event.stable) stable = draft;
    }
    if (event.done && ended) finalize(event.draft?.trim() || (stable === draft ? stable : ''));
  }

  async function start(event) {
    english = /^en\b/i.test(event.language);
    protocol = provider === 'fish' ? fishRecognitionProtocol(config, event) : volcengineRecognitionProtocol(config, resourceId);
    setupTimer = setTimeout(() => fail('timeout'), recognitionHandshakeTimeout + 1000);
    try {
      upstream = await connect(protocol, {
        signal: lifetime.signal,
        receive: receiveUpstream,
        disconnected: () => fail(ready && ended ? 'incomplete-transcript' : 'network'),
      });
      send(protocol.start);
    } catch (error) {
      const { upstreamStatus, logId } = error;
      const denied = provider === 'volcengine' && [401, 403].includes(upstreamStatus);
      const code = denied ? 'stream-permission' : upstreamStatus ? 'provider-refused' : 'network';
      fail(code, { upstreamStatus, logId });
    }
  }

  function receive(data, binary) {
    if (finished || ended) return;
    if (binary) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!protocol || !bytes.byteLength || bytes.byteLength > recognitionFrameLimit ||
          bytes.byteLength % 2 || size + bytes.byteLength > recordingLimit) {
        fail('invalid-audio');
        return;
      }
      size += bytes.byteLength;
      if (ready) sendAudio(bytes);
      else pending.push(bytes);
      return;
    }
    if (data.length > 1024) { fail('invalid-audio'); return; }
    let event;
    try { event = JSON.parse(data); } catch { fail('invalid-audio'); return; }
    if (event?.type === 'start' && !protocol) {
      const validRate = provider === 'fish' ? fishSampleRates.has(event.sampleRate) : event.sampleRate === 16000;
      if (validRate && provider) {
        void start(event).catch(() => fail('network'));
        return;
      }
    }
    if (event?.type !== 'end' || !protocol || !size) {
      fail(event?.type === 'end' && protocol ? 'no-speech' : 'invalid-audio');
      return;
    }
    ended = true;
    finalTimer = setTimeout(() => fail('timeout'), 8500);
    if (ready) send(protocol.audio(pcm.subarray(0, used), true));
  }

  return { receive, close: () => terminate() };
}
