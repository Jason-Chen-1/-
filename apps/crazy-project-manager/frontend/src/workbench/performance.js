import { createMicrophone } from './microphone.js';
import { createBackgroundMusic } from './background-music.js';
import { language, t } from '../i18n.js';
import { designerSpeech } from '../../../shared/designer-speech.mjs';
import { voiceClips } from './mandarin-voices.js';

const cast = ['zhou', 'lin', 'tang', 'yi'];
const effectUrls = {
  knock: '/assets/voices/mandarin/knock.wav',
  'client-desk': '/assets/voices/effects/client-desk.wav',
  'client-scold': '/assets/voices/effects/client-scold.wav',
  'client-bing': '/assets/voices/effects/client-bing.wav',
  'yi-hit': '/assets/voices/effects/yi-hit.wav',
};
const svgNS = 'http://www.w3.org/2000/svg';
const listeningWindow = 750;
const voiceSpeedMultiplier = 1.3;
const speechTextLimit = 180;
const onlineSpeechWait = 17_000;
const clientCueLoadWait = 160;
const maxClientCueTime = 900;
const deskRecordings = new Map(voiceClips.filter(([role, mood]) => role === 'yi' && mood === 'startled')
  .map(([, , text, url]) => [text, url]));
const pausedPlayback = new Set(['meeting-interjection', 'desk-reaction']);
const sentenceSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(language, { granularity: 'sentence' }) : null;
const ttsReasons = new Set(['unconfigured', 'missing-key', 'missing-voice', 'timeout', 'unavailable', 'invalid-input']);
const workStates = {
  accepted: 'working', queued: 'working', working: 'working', running: 'working',
  resumed: 'working', paused: 'paused', lazy: 'paused',
};
const heygenDelivery = {
  zhou: { normal: 0.95, angry: 1.02 },
  lin: { normal: 1.04, sharp: 1.08 },
  tang: { normal: 1.10, urgent: 1.14, excited: 1.17 },
  yi: { normal: 1.06, lazy: 0.87, startled: 1.16, resume: 1.11 },
};

function enhanceMascot(stage) {
  const body = stage?.querySelector('.mascot-body');
  if (!body || body.querySelector('.performance-tears')) return;
  const tears = document.createElementNS(svgNS, 'g');
  tears.setAttribute('class', 'performance-tears');
  tears.setAttribute('aria-hidden', 'true');
  tears.innerHTML = `<path d="M98 69q6-5 12 0m20 0q6-5 12 0" fill="none" stroke="#522e2a" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M98 74a6 6 0 1 0 12 0a6 6 0 1 0-12 0m31 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0" fill="#3d302d"/>
    <path d="M95 80q5 4 12 2v10q-4 14-9 7q-3-6-3-19m38 2q7 2 12-2q0 13-3 19q-5 7-9-7Z" fill="#88e5ff" stroke="#3b91bb" stroke-width="1.4"/>
    <path d="M98 84l2 10m40-10l-2 10" stroke="#eafbff" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="103" cy="72" r="2" fill="#fff0db"/><circle cx="134" cy="72" r="2" fill="#fff0db"/>
    <path d="M114 92q6-12 12 0Z" fill="#612c2d" stroke="#40232b" stroke-width="1.2"/>`;
  const phone = document.createElementNS(svgNS, 'g');
  phone.setAttribute('class', 'performance-phone');
  phone.setAttribute('aria-hidden', 'true');
  phone.innerHTML = `<g transform="rotate(-18 164 111)"><rect x="153" y="94" width="21" height="32" rx="4" fill="#333937" stroke="#201d21" stroke-width="2"/>
    <rect x="156" y="98" width="15" height="23" rx="2" fill="#8ce5cd"/>
    <path d="m162 104 5 5-5 5Z" fill="#254940"/><path d="M160 123h7" stroke="#9db6aa" stroke-linecap="round"/></g>`;
  body.append(phone, tears);
  const impact = document.createElement('span');
  impact.className = 'performance-impact';
  impact.setAttribute('aria-hidden', 'true');
  impact.innerHTML = `<strong>${t('啪！', 'BAM!')}</strong><b>QAQ</b>`;
  stage.append(impact);
}

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function untilStopped(ready, signal) {
  if (signal.aborted) return null;
  let interrupt;
  const stopped = new Promise(resolve => {
    interrupt = () => resolve(null);
    signal.addEventListener('abort', interrupt, { once: true });
  });
  try {
    return await Promise.race([ready, stopped]);
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

function splitSpeech(text) {
  const segments = [];
  let remaining = text.trim();
  while (remaining.length > speechTextLimit) {
    const sample = remaining.slice(0, speechTextLimit);
    let splitAt = 0;
    for (const boundary of sample.matchAll(/[。.!?！？；;，,\s]/g)) splitAt = boundary.index + 1;
    if (splitAt < speechTextLimit / 2) splitAt = sample.length - (/[\uD800-\uDBFF]$/.test(sample) ? 1 : 0);
    segments.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) segments.push(remaining);
  return segments;
}

function speechPieces(message) {
  if (message.role === 'yi') return splitSpeech(message.text).map(text => ({ text }));
  const explicit = message.clientCue;
  if (explicit === 'desk' || explicit === 'accent' || explicit === null) {
    return splitSpeech(message.text).map((text, index) => ({ text, cue: index === 0 ? explicit : null }));
  }
  const sentences = sentenceSegmenter ? Array.from(sentenceSegmenter.segment(message.text), ({ segment }) => segment)
    : message.text.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/);
  return sentences.filter(sentence => sentence.trim()).flatMap((sentence, sentenceIndex) =>
    splitSpeech(sentence).map((text, partIndex) => ({ text, cue: partIndex === 0 ? (sentenceIndex === 0 ? 'desk' : 'accent') : null })));
}

async function getHash(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const raw = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(raw), value => value.toString(16).padStart(2, '0')).join('');
}

export function createPerformance({
  recorder, onTranscript, onVoiceStatus, onTurnError, onTurnPrepare, onTurnStart, onTurnEnd, onAudioReady, getRole,
} = {}) {
  const stage = document.querySelector('[data-performer="yi"], #agentStage');
  const performers = new Map(cast.map(role => [
    role, role === 'yi' ? stage : document.querySelector(`[data-performer="${role}"]`),
  ]));
  enhanceMascot(stage);
  const lifecycle = new AbortController();
  let context;
  let gain;
  let effectsGain;
  let music;
  let muted = false;
  let volume = 0.88;
  let effectsEnabled = true;
  let effectsVolume = .88;
  let musicEnabled = true;
  let musicVolume = .22;
  let audioInteracted = false;
  let audioReady = false;
  let musicPaused = false;
  let musicUnavailable = false;
  let recordingId;
  let voicesPlaying = 0;
  let sequence;
  let preparingTurn;
  let activeTurn;
  let audio;
  let hitTimer;
  let hitLabel;
  let resumingTimer;
  let previousWork;
  let warmSource;
  let warmTimer;
  let effectsPrimed = false;
  let nextClientAccent = 'client-scold';
  let generatedId = 0;
  const effectAssets = new Map();
  const activeEffects = new Set();
  const impactAudio = new Set();
  const deskVoiceAssets = new Map();
  const preparedTurns = new Map();

  function record(type, data) {
    recorder?.record?.(type, { ...data, monotonicMs: performance.now() });
  }

  function effectsAudible() {
    return !muted && effectsEnabled && effectsVolume > 0;
  }

  function syncMusic() {
    if (!audioInteracted || musicUnavailable || context?.state !== 'running' || lifecycle.signal.aborted) return;
    const silent = muted || Boolean(recordingId) || musicPaused || document.hidden;
    const level = silent || !musicEnabled ? 0 : musicVolume * (voicesPlaying && volume > 0 ? .28 : 1);
    try {
      if (!music && level > 0) music = createBackgroundMusic(context);
      music?.setLevel(level, silent);
    } catch {
      musicUnavailable = true;
      music?.destroy();
      music = null;
    }
  }

  function audioContext() {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    if (!context) {
      try {
        context = new Audio({ latencyHint: 'interactive' });
        gain = context.createGain();
        gain.gain.value = volume;
        gain.connect(context.destination);
        effectsGain = context.createGain();
        effectsGain.gain.value = effectsAudible() ? effectsVolume : 0;
        effectsGain.connect(context.destination);
        context.addEventListener('statechange', syncMusic, { signal: lifecycle.signal });
      } catch {
        return;
      }
    }
    return context;
  }

  function unlockAudio() {
    const output = audioContext();
    if (!output) return;
    if (output.state === 'suspended' || output.state === 'interrupted') {
      void output.resume().then(outputReady).catch(() => {});
    } else {
      outputReady();
    }
    return output;
  }

  function outputReady() {
    keepOutputReady();
    syncMusic();
    if (audioInteracted && !audioReady && !muted && context?.state === 'running') {
      audioReady = true;
      onAudioReady?.();
    }
  }

  function closeWarmSource() {
    clearTimeout(warmTimer);
    warmSource?.stop();
    warmSource?.disconnect();
    warmSource = null;
  }

  function waitForAudioOutput(signal) {
    if (!context || context.state === 'running' || context.state === 'closed' || muted || signal.aborted) return;
    if (navigator.userActivation?.hasBeenActive) unlockAudio();
    const output = context;
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        output.removeEventListener('statechange', ready);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const ready = () => { if (output.state === 'running' || output.state === 'closed') finish(); };
      const timer = setTimeout(finish, 1_400);
      output.addEventListener('statechange', ready);
      signal.addEventListener('abort', finish, { once: true });
      ready();
    });
  }

  function keepOutputReady() {
    if (context?.state !== 'running' || muted || !context.createConstantSource) return;
    if (!warmSource) {
      warmSource = context.createConstantSource();
      warmSource.offset.value = 0;
      warmSource.connect(gain);
      warmSource.start();
    }
    clearTimeout(warmTimer);
    warmTimer = setTimeout(closeWarmSource, 5000);
  }

  async function decodeAsset(response, output, mime, signal) {
    const bytes = await response.arrayBuffer();
    if (signal.aborted) return null;
    const blob = new Blob([bytes], { type: mime });
    const [buffer, hash] = await Promise.all([
      output.decodeAudioData(bytes.slice(0)),
      response.headers.get('X-Media-Hash') || getHash(bytes),
    ]);
    if (signal.aborted) return null;
    return {
      hash, assetUrl: hash ? `/api/media/${hash}` : null, buffer, blob,
      provider: response.headers.get('X-Voice-Provider'),
    };
  }

  function prepareEffect(name) {
    if (!effectsAudible()) return Promise.resolve(null);
    if (effectAssets.has(name)) return effectAssets.get(name);
    const output = audioContext();
    if (!output || lifecycle.signal.aborted) return Promise.resolve(null);
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1800)]);
    const loading = fetch(effectUrls[name], { signal })
      .then(response => response.ok ? decodeAsset(response, output, 'audio/wav', signal) : null)
      .catch(() => null)
      .then(asset => {
        if (!asset) effectAssets.delete(name);
        return asset;
      });
    effectAssets.set(name, loading);
    return loading;
  }

  function prime(event) {
    if (event.isTrusted) audioInteracted = true;
    if (!unlockAudio() || !effectsAudible() || effectsPrimed) return;
    effectsPrimed = true;
    for (const name of Object.keys(effectUrls)) void prepareEffect(name);
  }

  for (const event of ['pointerdown', 'pointerup', 'keydown', 'click']) {
    document.addEventListener(event, prime, { capture: true, signal: lifecycle.signal });
  }
  document.addEventListener('visibilitychange', syncMusic, { signal: lifecycle.signal });
  window.addEventListener('pagehide', () => {
    music?.savePosition();
    music?.setLevel(0, true);
  }, { signal: lifecycle.signal });
  window.addEventListener('pageshow', syncMusic, { signal: lifecycle.signal });

  async function prepareSegment(segment, signal) {
    if (muted) return { reason: 'muted' };
    const output = audioContext();
    if (!output) return { reason: 'audio-unsupported' };
    const deadline = AbortSignal.timeout(onlineSpeechWait);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      const response = await fetch('/api/speech', {
        signal: requestSignal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: segment.role, mood: segment.mood, text: segment.text, language }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        const reason = ttsReasons.has(failure?.reason) ? failure.reason : response.status === 504 ? 'timeout' : 'unavailable';
        return { reason };
      }
      const asset = await decodeAsset(response, output, 'audio/mpeg', requestSignal);
      if (asset) return { asset };
    } catch {
      // A missing or undecodable response becomes a retryable turn error.
    }
    return { reason: deadline.aborted ? 'timeout' : 'unavailable' };
  }

  function prepareDeskReaction(turn) {
    if (muted || lifecycle.signal.aborted) return Promise.resolve({ reason: 'muted' });
    const text = designerSpeech(turn.speech ?? turn.text);
    if (!text) return Promise.resolve({ reason: 'invalid-input' });
    const known = deskVoiceAssets.get(text);
    if (known) return known;
    const ready = (async () => {
      const url = language === 'zh-CN' && deskRecordings.get(text);
      const output = audioContext();
      if (url && output) {
        const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1800)]);
        try {
          const response = await fetch(url, { signal });
          const asset = response.ok && await decodeAsset(response, output, 'audio/mpeg', signal);
          if (asset) return { asset: { ...asset, provider: 'recorded-tts' } };
        } catch { /* Refill the voice cache with the configured service. */ }
      }
      return prepareSegment({ role: 'yi', mood: 'startled', text }, lifecycle.signal);
    })().then(result => {
      if (!result.asset && deskVoiceAssets.get(text) === ready) deskVoiceAssets.delete(text);
      return result;
    });
    deskVoiceAssets.set(text, ready);
    return ready;
  }

  function startAudio(asset, data, { signal, kind = 'voice', onStarted, offsetMs = 0 } = {}) {
    if (!asset || muted || context?.state !== 'running' || signal?.aborted) return null;
    if (kind === 'effect' && !effectsAudible()) return null;
    keepOutputReady();
    const source = context.createBufferSource();
    source.buffer = asset.buffer;
    const delivery = asset.provider === 'openrouter' ? heygenDelivery[data.role] : null;
    const characterRate = delivery && Object.hasOwn(delivery, data.mood)
      ? delivery[data.mood] : delivery?.normal ?? 1;
    const playbackRate = kind === 'voice' ? characterRate * voiceSpeedMultiplier : 1;
    source.playbackRate.value = playbackRate;
    source.connect(kind === 'effect' ? effectsGain : gain);
    const startedAt = context.currentTime;
    const durationMs = Math.round(asset.buffer.duration * 1000);
    const offset = Math.max(0, Math.min(asset.buffer.duration - .001, offsetMs / 1000));
    const initialOffsetMs = Math.round(offset * 1000);
    const elapsedDuration = (asset.buffer.duration - offset) / playbackRate;
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    const media = {
      ...data, kind, hash: asset.hash, assetUrl: asset.assetUrl, durationMs, playbackRate,
      source: data.source || asset.provider || 'tts',
    };
    const abort = () => stop(String(signal.reason || 'interrupt'));
    let ended = false;
    let started = false;
    let duck = false;
    let clockPoll;
    let endPoll;
    const watchdog = setTimeout(() => stop('output-stalled'), elapsedDuration * 1000 + 1300);

    function readClock() {
      const stamp = context.getOutputTimestamp?.();
      return stamp?.performanceTime > 0 ? stamp.contextTime : context.currentTime;
    }

    function observeStart() {
      if (ended || started) return;
      if (readClock() <= startedAt) {
        clockPoll = setTimeout(observeStart, 12);
        return;
      }
      started = true;
      if (!signal?.aborted) onStarted?.();
      record('audio-start', { ...media, offsetMs: initialOffsetMs });
      const saving = recorder?.media?.(asset.blob, media);
      void Promise.resolve(saving).catch(() => record('media-error', media));
    }

    function stop(reason) {
      if (ended) return;
      clearTimeout(clockPoll);
      observeStart();
      ended = true;
      clearTimeout(clockPoll);
      clearTimeout(endPoll);
      clearTimeout(watchdog);
      if (reason !== 'ended') source.stop();
      source.disconnect();
      signal?.removeEventListener('abort', abort);
      if (duck) {
        voicesPlaying--;
        syncMusic();
      }
      const advanced = Math.round((readClock() - startedAt) * playbackRate * 1000);
      const stopOffset = reason === 'ended' ? durationMs : Math.min(durationMs, initialOffsetMs + Math.max(0, advanced));
      record(started ? 'audio-stop' : 'audio-unavailable', { ...media, offsetMs: stopOffset, reason });
      finish({ reason, offsetMs: stopOffset });
    }

    source.onended = function finishedRendering() {
      if (ended) return;
      if (readClock() + 0.003 >= startedAt + elapsedDuration) stop('ended');
      else endPoll = setTimeout(finishedRendering, 12);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      source.start(startedAt, offset);
    } catch {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', abort);
      source.disconnect();
      return null;
    }
    if (kind === 'voice') {
      duck = true;
      voicesPlaying++;
      syncMusic();
    }
    observeStart();
    return { stop, completion };
  }

  function startEffect(asset, data, signal) {
    try {
      const effect = startAudio(asset, data, { kind: 'effect', signal });
      if (effect) {
        activeEffects.add(effect);
        void effect.completion.then(() => activeEffects.delete(effect));
      }
      return effect;
    } catch {
      return null;
    }
  }

  async function playClientCue(segment, signal) {
    const { cue, meta } = segment;
    if (!effectsAudible() || !cue || segment.offsetMs > 0 || segment.cuePlayed) return;
    const name = cue === 'desk' ? 'client-desk' : nextClientAccent;
    const readySignal = AbortSignal.any([signal, AbortSignal.timeout(clientCueLoadWait)]);
    const asset = await untilStopped(prepareEffect(name), readySignal);
    if (!asset || signal.aborted || muted) return;
    const playbackTime = Math.min(maxClientCueTime, Math.ceil(asset.buffer.duration * 1000) + 200);
    const cueSignal = AbortSignal.any([signal, AbortSignal.timeout(playbackTime)]);
    const effect = startEffect(asset, {
      role: meta.role, messageId: meta.messageId, segment: meta.segment, segmentId: `${meta.segmentId}:cue`, source: name,
    }, cueSignal);
    if (!effect) return;
    segment.cuePlayed = true;
    if (cue === 'accent') nextClientAccent = name === 'client-scold' ? 'client-bing' : 'client-scold';
    audio = effect;
    await effect.completion;
    if (audio === effect) audio = null;
  }

  function stopImpactAudio(reason) {
    for (const controller of impactAudio) controller.abort(reason);
    impactAudio.clear();
  }

  function syncEffects() {
    const audible = effectsAudible();
    if (effectsGain) effectsGain.gain.value = audible ? effectsVolume : 0;
    if (!audible) {
      stopImpactAudio('effects-muted');
      for (const effect of activeEffects) effect.stop('effects-muted');
    }
  }

  async function playImpactAudio(action, signal) {
    const clips = ['knock', 'yi-hit'].map(name => ({ name, ready: prepareEffect(name) }));
    await waitForAudioOutput(AbortSignal.any([signal, AbortSignal.timeout(260)]));
    for (const { name, ready } of clips) {
      if (signal.aborted || !effectsAudible()) return;
      const asset = await untilStopped(ready, AbortSignal.any([signal, AbortSignal.timeout(300)]));
      if (!asset || signal.aborted || !effectsAudible()) continue;
      const effect = startEffect(asset, {
        ...action, segmentId: name === 'knock' ? action.actionId : `${action.actionId}:yi-hit`, source: name,
      }, signal);
      if (effect && (await effect.completion).reason !== 'ended') return;
    }
  }

  function finishTurn(turn, reason) {
    if (preparingTurn === turn) {
      preparingTurn = null;
      onTurnEnd?.(turn, reason, { started: false });
      return;
    }
    if (activeTurn !== turn) return;
    const actor = performers.get(turn.role);
    actor?.classList.remove('is-performing');
    if (actor) delete actor.dataset.mood;
    activeTurn = null;
    record('subtitle-end', { messageId: turn.id, role: turn.role, reason });
    onTurnEnd?.(turn, reason, { started: true });
  }

  function announceTurn(turn) {
    if (preparingTurn !== turn) return;
    preparingTurn = null;
    activeTurn = turn;
    const actor = performers.get(turn.role);
    if (actor) {
      actor.dataset.mood = turn.mood || '';
      actor.classList.add('is-performing');
    }
    onTurnStart?.(turn);
    record('subtitle-start', {
      messageId: turn.id, role: turn.role, text: turn.text, mood: turn.mood,
      versionId: turn.versionId, replyTo: turn.replyTo,
    });
  }

  function stop(reason = 'interrupt') {
    sequence?.abort(reason);
    sequence = null;
    if (!pausedPlayback.has(reason)) {
      for (const plan of preparedTurns.values()) plan.controller.abort(reason);
      preparedTurns.clear();
    }
    audio?.stop(reason);
    audio = null;
    if (reason === 'session-change' || reason === 'destroy') {
      stopImpactAudio(reason);
      nextClientAccent = 'client-scold';
    }
    if (activeTurn) finishTurn(activeTurn, reason);
    if (preparingTurn) finishTurn(preparingTurn, reason);
  }

  const microphone = createMicrophone({
    recorder, onTranscript, getRole,
    onVoiceStatus(status) {
      if (status.state === 'starting') recordingId = status.recordingId;
      if (recordingId === status.recordingId && ['idle', 'error'].includes(status.state)) recordingId = undefined;
      syncMusic();
      onVoiceStatus?.(status);
    },
  });

  function turnPlan(turn) {
    let text = turn?.speech ?? turn?.text;
    if (turn?.role === 'yi' && typeof text === 'string') text = designerSpeech(text);
    if (!cast.includes(turn?.role) || typeof text !== 'string' || !text.trim()) return null;
    const id = turn.id || turn.messageId || `speech-${++generatedId}`;
    const previous = preparedTurns.get(id);
    if (previous?.message.text === text && previous.message.role === turn.role && previous.message.mood === turn.mood &&
      previous.message.clientCue === turn.clientCue) return previous;
    previous?.controller.abort('replaced');

    const message = { ...turn, id, speech: text, text };
    const controller = new AbortController();
    const pieces = speechPieces(message);
    if (pieces.some(part => part.cue === 'desk')) void prepareEffect('client-desk');
    if (pieces.some(part => part.cue === 'accent')) {
      void prepareEffect('client-scold');
      void prepareEffect('client-bing');
    }
    const segments = pieces.map(({ text, cue }, segment) => {
      const meta = { text, role: message.role, mood: message.mood, messageId: id, segment, segmentId: `${id}.${segment}` };
      const ready = message.kind === 'desk-reaction' ? prepareDeskReaction({ text }) : prepareSegment(meta, controller.signal);
      return { meta, ready, cue, offsetMs: 0 };
    });
    const plan = { message, segments, controller, nextSegment: 0 };
    preparedTurns.set(id, plan);
    return plan;
  }

  function prepareTurns(turns = []) {
    if (muted || lifecycle.signal.aborted) return;
    for (const turn of turns) if (turn?.id || turn?.messageId) turnPlan(turn);
  }

  function releasePlan(plan, reason) {
    if (preparedTurns.get(plan.message.id) !== plan) return;
    preparedTurns.delete(plan.message.id);
    plan.controller.abort(reason);
  }

  function discardTurns(ids) {
    const discarded = new Set(ids);
    if (discarded.has(activeTurn?.id) || discarded.has(preparingTurn?.id)) stop('meeting-interjection');
    for (const id of discarded) {
      const plan = preparedTurns.get(id);
      if (plan) releasePlan(plan, 'discarded');
    }
  }

  async function playSegment(segment, message, signal) {
    const { meta, ready } = segment;
    const prepared = await untilStopped(ready, signal);
    if (!prepared || signal.aborted) return null;
    const { asset, reason: synthesisError } = prepared;
    if (asset && segment.offsetMs >= Math.round(asset.buffer.duration * 1000)) return null;
    if (asset) await waitForAudioOutput(signal);
    if (signal.aborted) return null;

    let reason = muted ? 'muted' : synthesisError;
    if (!reason && context?.state === 'running') {
      await playClientCue(segment, signal);
      if (signal.aborted) return null;
      if (muted) reason = 'muted';
    }
    if (!reason) {
      if (context?.state !== 'running') {
        reason = 'autoplay-blocked';
      } else {
        let spoken;
        try {
          spoken = startAudio(asset, meta, { signal, offsetMs: segment.offsetMs, onStarted: () => announceTurn(message) });
        } catch {
          spoken = null;
        }
        if (spoken) {
          audio = spoken;
          const result = await spoken.completion;
          if (audio === spoken) audio = null;
          segment.offsetMs = result.offsetMs;
          return result.reason === 'ended' ? null : { reason: result.reason, ready: true };
        }
        reason = 'output-stalled';
      }
    }
    record('audio-unavailable', { ...meta, reason });
    return { reason, ready: Boolean(asset) };
  }

  async function play(turns = []) {
    if (lifecycle.signal.aborted) return;
    if (sequence) stop('replaced');
    if (navigator.userActivation?.hasBeenActive) unlockAudio();
    const controller = new AbortController();
    sequence = controller;
    const { signal } = controller;
    const plans = turns.map(turnPlan).filter(Boolean);
    try {
      for (const plan of plans) {
        if (signal.aborted) break;
        const { message, segments } = plan;
        preparingTurn = message;
        onTurnPrepare?.(message);
        let failure;
        if (message.impact) await untilStopped(message.impact, signal);
        if (signal.aborted) break;
        while (plan.nextSegment < segments.length) {
          failure = await playSegment(segments[plan.nextSegment], message, signal);
          if (signal.aborted || failure) break;
          plan.nextSegment += 1;
        }
        if (signal.aborted) break;
        const reason = failure?.reason;
        if (!(failure?.ready && (reason === 'autoplay-blocked' || reason === 'muted'))) releasePlan(plan, reason || 'finished');
        finishTurn(message, reason || 'ended');
        if (reason) onTurnError?.(message, reason);
        else if (!message.meetingTurnId && !message.designerTurnId && message.kind !== 'desk-reaction') await wait(110, signal);
      }
    } finally {
      if (signal.aborted && !pausedPlayback.has(signal.reason)) {
        for (const plan of plans) releasePlan(plan, signal.reason);
      }
      if (sequence === controller) sequence = null;
    }
  }

  function slap({ source = 'desk' } = {}) {
    if (!stage) return;
    const actionId = `slap-${Math.round(performance.now() * 1000)}`;
    const action = { actionId, role: 'yi', source, label: 'QAQ', durationMs: listeningWindow };
    record('impact-request', action);
    if (hitLabel) record('impact-end', { ...hitLabel, reason: 'retrigger' });
    hitLabel = action;
    stage.classList.remove('is-hit');
    void stage.offsetWidth;
    stage.classList.add('is-hit');
    requestAnimationFrame(() => {
      if (hitLabel === action) record('impact-start', action);
    });
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => {
      stage.classList.remove('is-hit');
      hitLabel = null;
      record('impact-end', { ...action, reason: 'ended' });
    }, listeningWindow);
    if (effectsAudible() && unlockAudio()) {
      const controller = new AbortController();
      impactAudio.add(controller);
      return playImpactAudio(action, controller.signal).catch(() => {}).finally(() => impactAudio.delete(controller));
    }
  }

  function setJob(job) {
    if (!stage) return;
    const work = workStates[job?.status] || 'idle';
    if (work === previousWork) return;
    stage.dataset.work = work;
    if (previousWork === 'paused' && work === 'working') {
      clearTimeout(resumingTimer);
      stage.classList.add('is-resuming');
      resumingTimer = setTimeout(() => stage.classList.remove('is-resuming'), 410);
    }
    previousWork = work;
  }

  return {
    play, prepareTurns, prepareDeskReaction, discardTurns, stop, slap, setJob, unlockAudio, bindMic: microphone.bind,
    cancelMic: microphone.cancel,
    setMuted(value) {
      const changed = muted !== Boolean(value);
      muted = Boolean(value);
      if (!changed) return;
      record('audio-mute', { muted });
      if (muted) {
        closeWarmSource();
        audio?.stop('muted');
        stopImpactAudio('muted');
      }
      syncMusic();
      syncEffects();
    },
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      const next = Math.min(1, Math.max(0, value));
      if (next === volume) return;
      volume = next;
      if (gain) gain.gain.value = volume;
      record('audio-volume', { volume });
      syncMusic();
    },
    setSoundMix(options) {
      effectsEnabled = options.effectsEnabled !== false;
      effectsVolume = Number.isFinite(options.effectsVolume) ? Math.max(0, Math.min(1, options.effectsVolume)) : .88;
      musicEnabled = options.musicEnabled !== false;
      musicVolume = Number.isFinite(options.musicVolume) ? Math.max(0, Math.min(1, options.musicVolume)) : .22;
      syncEffects();
      syncMusic();
    },
    pauseMusic(value) {
      musicPaused = Boolean(value);
      syncMusic();
    },
    destroy() {
      stop('destroy');
      microphone.destroy();
      clearTimeout(hitTimer);
      clearTimeout(resumingTimer);
      stage?.classList.remove('is-hit', 'is-resuming');
      lifecycle.abort();
      closeWarmSource();
      music?.destroy();
      void context?.close().catch(() => {});
    },
  };
}
