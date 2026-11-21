import { language, t } from '../i18n.js';

const Speech = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const recognitionLanguage = language === 'en' ? 'en-US' : 'zh-CN';
const holdLimit = 59000;
const pcmRate = 16000;
const audioFormats = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const messages = {
  'not-allowed': t('麦克风权限未开启，可以直接打字。', 'Microphone access is off. You can type instead.'),
  'service-not-allowed': t('当前浏览器无法使用语音识别，可以直接打字。', 'Speech recognition is unavailable in this browser. You can type instead.'),
  'audio-capture': t('未找到可用的麦克风，可以直接打字。', 'No microphone was found. You can type instead.'),
  'no-speech': t('没听清这句话，请再说一次或直接打字。', 'No speech was recognized. Try again or type your message.'),
  network: t('语音识别连接失败，可以直接打字。', 'Could not connect to speech recognition. You can type instead.'),
};
const recognitionTimeout = t('语音识别等待超时，可以直接打字。', 'Speech recognition timed out. You can type instead.');
const streamErrors = {
  network: messages.network,
  timeout: recognitionTimeout,
  'recording-timeout': t('录音已超时，请重新按住录音。', 'Recording timed out. Hold to record again.'),
  'invalid-audio': t('录音格式无效，可以直接打字。', 'The recording format is invalid. You can type instead.'),
  'no-speech': messages['no-speech'],
  'stream-permission': t('火山语音识别未获授权，请检查 API Key 与所选资源的权限。', 'Volcengine speech recognition was denied. Check your API key and access to the selected resource.'),
  'provider-refused': t('语音识别服务拒绝了连接，请检查 API 设置。', 'The recognition service refused the connection. Check your API settings.'),
  'incomplete-transcript': t('识别服务没有返回最终文本，可以用已识别的草稿继续编辑。', 'No final transcript was returned. You can edit the recognized draft.'),
};

function streamErrorDetails(message) {
  const { code, upstreamStatus, upstreamCode, logId } = message;
  const diagnostic = [Number.isInteger(upstreamStatus) && `HTTP ${upstreamStatus}`,
    Number.isInteger(upstreamCode) && String(upstreamCode)].filter(Boolean).join(' / ');
  const error = Object.hasOwn(streamErrors, code) ? streamErrors[code] : messages.network;
  return { error: diagnostic ? `${error} (${diagnostic})` : error, errorCode: code, upstreamStatus, upstreamCode, logId };
}

function withTimeout(promise, delay, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, delay, fallback); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startSpeechRecognition(stream, local, onPartial) {
  if (!Speech) return null;
  const recognition = new Speech();
  recognition.lang = recognitionLanguage;
  recognition.interimResults = true;
  recognition.continuous = true;
  if (local) recognition.processLocally = true;
  let finalText = '';
  let interim = '';
  let error;
  let finish;
  let ended = false;
  const provider = local ? 'browser-local' : 'browser';
  const result = new Promise(resolve => { finish = resolve; });
  const value = () => ({ text: finalText, interim, error, provider });
  function end() {
    if (ended) return;
    ended = true;
    if (!error && interim && finalText !== interim) error = streamErrors['incomplete-transcript'];
    finish(value());
  }

  recognition.onresult = event => {
    if (ended) return;
    const parts = Array.from(event.results, part => [part[0]?.transcript?.trim() || '', part.isFinal]);
    const separator = language === 'en' ? ' ' : '';
    finalText = parts.filter(([, complete]) => complete).map(([text]) => text).filter(Boolean).join(separator);
    interim = parts.map(([text]) => text).filter(Boolean).join(separator);
    onPartial(interim);
  };
  recognition.onerror = event => {
    error = messages[event.error] ?? t('语音识别失败，可以直接打字。', 'Speech recognition failed. You can type instead.');
    end();
  };
  recognition.onend = end;
  try {
    recognition.start(stream.getAudioTracks()[0]);
  } catch {
    error = t('无法启动语音识别，可以直接打字。', 'Could not start speech recognition. You can type instead.');
    end();
  }
  return {
    result,
    async finish() {
      if (!ended) {
        try { recognition.stop(); } catch { end(); }
      }
      const completed = await withTimeout(result, 2200, null);
      if (completed) return completed;
      const latest = value();
      try { recognition.abort(); } catch {}
      end();
      return latest.text && latest.text === latest.interim ? latest : { ...latest, error: recognitionTimeout };
    },
    cancel() {
      if (!ended) { try { recognition.abort(); } catch {} }
      end();
    },
  };
}

function capturePCM(stream, onChunk) {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Audio || !globalThis.AudioWorkletNode) return null;
  let context;
  try { context = new Audio({ latencyHint: 'interactive' }); } catch { return null; }
  let worklet;
  let source;
  let flushDone = () => {};
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    flushDone();
    source?.disconnect();
    worklet?.disconnect();
    if (context.state !== 'closed') void context.close().catch(() => {});
  }

  const ready = (async () => {
    try {
      const started = await withTimeout(Promise.all([
        context.audioWorklet.addModule('/recognition-worklet.js'), context.resume(),
      ]), 3500, null);
      if (!started || closed) {
        close();
        return false;
      }
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, 'recognition-pcm', { channelCount: 1 });
      worklet.port.onmessage = ({ data }) => {
        if (data === 'flushed') flushDone();
        else if (!closed) onChunk(data);
      };
      const silence = context.createGain();
      silence.gain.value = 0;
      source.connect(worklet).connect(silence).connect(context.destination);
      return true;
    } catch {
      close();
      return false;
    }
  })();

  return {
    ready, close,
    async flush() {
      if (closed || !worklet) return;
      const flushed = new Promise(resolve => { flushDone = resolve; });
      worklet.port.postMessage('flush');
      await withTimeout(flushed, 75);
    },
  };
}

function startStreamingRecognition(provider, onPartial) {
  const endpoint = new URL('/api/recognition', location.href);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try { socket = new WebSocket(endpoint); } catch { return null; }
  const pending = [];
  let pendingBytes = 0;
  let complete;
  let latestDraft = '';
  let ended = false;
  let disposed = false;
  const result = new Promise(resolve => { complete = resolve; });
  const connectTimer = setTimeout(() => settle({ error: recognitionTimeout, errorCode: 'timeout' }), 9500);

  function settle(value) {
    if (disposed) return;
    disposed = true;
    clearTimeout(connectTimer);
    pending.length = 0;
    complete({ text: '', interim: latestDraft, provider, ...value });
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }

  function fail() {
    settle({ error: messages.network, errorCode: 'network' });
  }

  function send(data) {
    if (disposed) return;
    try {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 512 * 1024) {
        socket.send(data);
      } else if (socket.readyState === WebSocket.CONNECTING && pendingBytes < 512 * 1024) {
        pending.push(data);
        pendingBytes += data.byteLength ?? 0;
      } else {
        fail();
      }
    } catch {
      fail();
    }
  }

  socket.onopen = () => {
    send(JSON.stringify({ type: 'start', sampleRate: pcmRate, language: recognitionLanguage }));
    for (const data of pending.splice(0)) send(data);
  };
  socket.onmessage = ({ data }) => {
    if (disposed) return;
    let message;
    try { message = JSON.parse(data); } catch { fail(); return; }
    if (message?.type === 'ready') {
      clearTimeout(connectTimer);
      if (message.provider === 'fish' || message.provider === 'volcengine') provider = message.provider;
    } else if (message?.type === 'draft' && typeof message.text === 'string') {
      latestDraft = message.text;
      onPartial(latestDraft, provider);
    } else if (message?.type === 'final' && ended && typeof message.text === 'string') {
      settle({ text: message.text });
    } else if (message?.type === 'error') {
      settle(streamErrorDetails(message));
    }
  };
  socket.onerror = fail;
  socket.onclose = fail;

  return {
    result, send,
    async finish() {
      if (ended || disposed) return result;
      ended = true;
      send(JSON.stringify({ type: 'end' }));
      const completed = await withTimeout(result, 9800, null);
      if (completed) return completed;
      settle({ error: recognitionTimeout, errorCode: 'timeout' });
      return result;
    },
    cancel: fail,
  };
}

function makeWav(chunks, sampleRate) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (!size) return null;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const encode = new TextEncoder();
  header.set(encode.encode('RIFF'), 0);
  view.setUint32(4, 36 + size, true);
  header.set(encode.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(encode.encode('data'), 36);
  view.setUint32(40, size, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

function startMediaRecorder(stream, onStop) {
  if (!globalThis.MediaRecorder) return null;
  try {
    const mimeType = audioFormats.find(type => MediaRecorder.isTypeSupported(type));
    const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    media.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    media.onstop = () => {
      onStop(chunks.length ? new Blob(chunks, { type: media.mimeType }) : null);
    };
    media.start(180);
    return media;
  } catch {
    return null;
  }
}

export function createMicrophone({ recorder, onTranscript, onVoiceStatus, getRole }) {
  const lifecycle = new AbortController();
  let localAvailable = false;
  void Promise.resolve()
    .then(() => Speech?.available?.({ langs: [recognitionLanguage], processLocally: true }))
    .then(result => { localAvailable = result === 'available'; })
    .catch(() => {});
  let pendingSupport;
  let active;

  function recognitionSupport() {
    if (!pendingSupport) {
      pendingSupport = fetch('/api/speech', {
        cache: 'no-store', signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(2800)]),
      }).then(response => response.ok ? response.json() : null).catch(() => null).finally(() => { pendingSupport = undefined; });
    }
    return pendingSupport;
  }

  function streamingProvider(capabilities) {
    return capabilities?.asrStreaming || (capabilities?.asr ? 'fish' : null);
  }

  function record(type, capture, data = {}) {
    capture.recorder?.record?.(type, {
      ...data, recordingId: capture.id, role: capture.role, review: capture.review,
      monotonicMs: performance.now(),
    });
  }

  function notify(capture, state, extra = {}) {
    capture.button.dataset.mic = state;
    onVoiceStatus?.({
      state, role: capture.role, review: capture.review, recordingId: capture.id, provider: capture.provider,
      recognitionMode: capture.recognitionMode, ...extra,
    });
  }

  function finishMedia(capture) {
    if (capture.media?.state === 'recording') capture.media.stop();
  }

  function finishCapture(capture) {
    clearTimeout(capture.timer);
    capture.pcm?.close();
    capture.stream?.getTracks().forEach(track => track.stop());
    if (active === capture) active = null;
  }

  function cancel(reason = 'cancelled') {
    const capture = active;
    if (!capture) return;
    capture.released = true;
    capture.cancelled = true;
    void capture.handler?.then(handler => handler?.cancel()).catch(() => {});
    finishMedia(capture);
    finishCapture(capture);
    record('recording-cancel', capture, { reason });
    notify(capture, 'idle');
  }

  function fail(capture, error, text = '', diagnostics = {}) {
    if (active !== capture) return;
    void capture.handler?.then(handler => handler?.cancel()).catch(() => {});
    finishMedia(capture);
    finishCapture(capture);
    record('recording-error', capture, { error, text, ...diagnostics });
    notify(capture, 'error', { error, text, ...diagnostics });
  }

  async function start(button, options, input) {
    const role = options.getRole?.() || getRole?.();
    if (!role || options.beforeRecord?.() === false) return;
    cancel('new-recording');
    const capture = {
      id: crypto.randomUUID?.() ?? `rec-${Date.now()}-${Math.round(performance.now())}`,
      button, role, input, review: Boolean(options.getReview?.()), released: false,
      recorder: recorder?.capture?.() ?? recorder,
    };
    active = capture;
    record('recording-request', capture, { input: input.type });
    notify(capture, 'starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      fail(capture, t('当前页面无法访问麦克风，可以直接打字。', 'This page cannot access your microphone. You can type instead.'));
      return;
    }

    let capabilities;
    const readingCapabilities = recognitionSupport().then(value => { capabilities = value; return value; });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (error) {
      fail(capture, messages[error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture']);
      return;
    }
    if (active !== capture || capture.released) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    capture.stream = stream;
    capture.start = performance.now();
    const archive = blob => {
      if (!blob) {
        record('recording-empty', capture);
        return;
      }
      const upload = capture.recorder?.media?.(blob, {
        kind: 'recording', recordingId: capture.id, role: capture.role,
        cancelled: capture.cancelled, monotonicMs: capture.start,
      });
      void Promise.resolve(upload).then(asset => {
        if (asset) record('recording-saved', capture, { hash: asset.hash, assetUrl: asset.url });
      }).catch(() => record('media-error', capture, { kind: 'recording' })).finally(() => {
        if (capture.cancelled) void capture.recorder?.flush?.();
      });
    };
    capture.media = startMediaRecorder(stream, archive);
    record('recording-start', capture, { captured: Boolean(capture.media) });
    capture.recognitionMode = capabilities?.asrMode;
    capture.provider = streamingProvider(capabilities) || undefined;
    const partial = (text, provider) => {
      if (active !== capture || capture.recognitionMode === 'volcengine-sentence') return;
      if (provider) capture.provider = provider;
      if (capture.interim === text) return;
      capture.interim = text;
      record('transcript-interim', capture, { text });
      notify(capture, capture.released ? 'processing' : 'recording', { text });
    };
    let live;
    const queued = [];
    const archiveChunks = capture.media ? null : [];
    if (!capabilities || capture.provider || archiveChunks) {
      capture.pcm = capturePCM(stream, bytes => {
        archiveChunks?.push(bytes);
        if (live) live.send(bytes);
        else queued.push(bytes);
      });
    }
    capture.stopPCM = async () => {
      if (!await capture.pcm?.ready) return;
      await capture.pcm.flush();
      capture.pcm.close();
      if (archiveChunks?.length) archive(makeWav(archiveChunks, pcmRate));
    };
    const audioUnavailable = t('当前浏览器无法启动录音，可以直接打字。', 'This browser could not start recording. You can type instead.');
    capture.handler = (async () => {
      const capabilities = await readingCapabilities;
      if (active !== capture) return null;
      if (!capabilities) throw new Error(messages.network);
      capture.recognitionMode = capabilities.asrMode;
      const provider = streamingProvider(capabilities);
      if (!provider && capabilities.asrMode !== 'browser') {
        throw new Error(t('当前配置的语音识别不可用，请检查 API 设置。', 'The selected speech recognition service is unavailable. Check API settings.'));
      }
      let handler;
      if (provider) {
        capture.provider = provider;
        if (!capture.pcm) throw new Error(audioUnavailable);
        live = startStreamingRecognition(provider, partial);
        if (!live) throw new Error(messages.network);
        handler = live;
        for (const bytes of queued.splice(0)) live.send(bytes);
        void capture.pcm.ready.then(ready => {
          if (!ready) fail(capture, audioUnavailable, capture.interim);
        });
      } else {
        if (!archiveChunks) capture.pcm?.close();
        queued.length = 0;
        if (capture.released) return null;
        capture.provider = localAvailable ? 'browser-local' : 'browser';
        handler = startSpeechRecognition(stream, localAvailable, partial);
        if (!handler) throw new Error(t('当前浏览器不支持语音识别，可以直接打字。', 'This browser does not support speech recognition. You can type instead.'));
      }
      void handler.result.then(result => {
        if (result.error && !capture.released) {
          const { error, interim, errorCode, upstreamStatus, upstreamCode, logId } = result;
          fail(capture, error, interim, { errorCode, upstreamStatus, upstreamCode, logId });
        }
      });
      notify(capture, capture.released ? 'processing' : 'recording', { text: capture.interim });
      return handler;
    })().catch(error => {
      fail(capture, error.message || messages.network, capture.interim);
      return null;
    });
    capture.timer = setTimeout(() => void release(capture), holdLimit);
  }

  async function release(capture) {
    if (!capture || capture.released || active !== capture) return;
    capture.released = true;
    if (capture.start === undefined) {
      cancel('released-before-capture');
      return;
    }
    record('recording-end', capture, { durationMs: Math.round(performance.now() - capture.start) });
    notify(capture, 'processing', { text: capture.interim });
    finishMedia(capture);
    const audioStopped = capture.stopPCM();
    const handler = await capture.handler;
    if (active !== capture) return;
    const streaming = capture.provider === 'fish' || capture.provider === 'volcengine';
    if (streaming) {
      await audioStopped;
      if (active !== capture) return;
      capture.stream?.getTracks().forEach(track => track.stop());
    }
    const result = await handler?.finish();
    if (!streaming) await audioStopped;
    if (active !== capture) return;
    const text = result?.text?.trim();
    if (!text || result?.error) {
      const { errorCode, upstreamStatus, upstreamCode, logId } = result || {};
      fail(capture, result?.error || messages['no-speech'], result?.interim || capture.interim || text,
        { errorCode, upstreamStatus, upstreamCode, logId });
      return;
    }
    capture.provider = result.provider;
    finishCapture(capture);
    record('transcript-final', capture, { text, provider: result.provider });
    notify(capture, 'idle');
    try {
      await onTranscript?.({ role: capture.role, text, review: capture.review, recordingId: capture.id, provider: result.provider });
    } catch {
      const error = t('转写已完成，发送失败。可以复制识别结果继续。', 'The recording was transcribed, but the message could not be sent. Copy the transcript to continue.');
      record('transcript-send-error', capture, { text, error });
      notify(capture, 'error', { text, error });
    }
  }

  function bind(button, options = {}) {
    if (!button) return () => {};
    const binding = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, binding.signal]);
    button.classList.add('push-mic');
    const handle = (event, action) => {
      const capture = active;
      if (capture?.button === button && capture.input.id === (event.pointerId ?? event.key)) action(capture);
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || button.disabled) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      void start(button, options, { type: 'pointer', id: event.pointerId });
    }, { signal });
    button.addEventListener('pointerup', event => handle(event, release), { signal });
    button.addEventListener('pointercancel', event => handle(event, () => cancel('pointercancel')), { signal });
    button.addEventListener('lostpointercapture', event => {
      handle(event, capture => { if (!capture.released) cancel('lostpointercapture'); });
    }, { signal });
    button.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    const keyHandler = (event, action) => {
      if (![' ', 'Enter'].includes(event.key) || event.isComposing || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) action();
    };
    button.addEventListener('keydown', event => keyHandler(event, () => {
      void start(button, options, { type: 'keyboard', id: event.key });
    }), { signal });
    button.addEventListener('keyup', event => keyHandler(event, () => handle(event, release)), { signal });
    button.addEventListener('click', event => {
      if (event.detail || button.disabled) return;
      if (active?.button === button) void release(active);
      else void start(button, options, { type: 'accessible', id: 'click' });
    }, { signal });
    return () => binding.abort();
  }

  window.addEventListener('blur', () => {
    if (active && !active.released) cancel('window-blur');
  }, { signal: lifecycle.signal });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active || event.isComposing) return;
    event.preventDefault();
    cancel('escape');
  }, { signal: lifecycle.signal });

  return {
    bind, cancel,
    destroy() {
      cancel('destroy');
      lifecycle.abort();
    },
  };
}
