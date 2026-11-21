import {normalizeApiKey} from './credentials.mjs';
import {fetchWithoutRedirect} from './upstream.mjs';

const voices = {
  rick: '010da99c66f44d319159c8588315f22c',
  june: '33f931ec7a8749c88cda37f1100a4809',
  chad: '0207f2fa259f4c30a4ade44d1d14f810',
};
const performance = {
  rick: {cue: '[confident] [in a hurry tone]', preview: 'We have twenty minutes, two opinions too many, and one poster. Pick a direction we can actually deliver.'},
  june: {cue: '[sarcastic] [disdainful]', preview: 'Oh, brilliant. We have made the logo enormous and the actual information invisible. A triumph of absolutely nothing.'},
  chad: {cue: '[relaxed] [confident]', preview: 'Yo, hold up. That poster has zero pulse. Give it some room, a little attitude, and let the damn thing breathe.'},
};
const emotions = new Map([['annoyed', '[frustrated]'], ['excited', '[excited]'], ['amused', '[sarcastic]'], ['calm', '[calm]']]);
const models = new Set(['s2.1-pro', 's2.1-pro-free', 's2-pro', 'drama-3']);

export const fishDefaults = {apiKey: '', model: 's2.1-pro', enabled: false, speed: 1.12, voices};

export function updatedFish(data, previous) {
  const apiKey = normalizeApiKey(data.apiKey || previous.apiKey, 'Fish Audio API Key');
  const model = data.model || previous.model;
  if (!models.has(model)) throw new Error('Choose one of the supported Fish Audio models.');
  const selected = {...previous.voices};
  if (data.voices) {
    for (const who of Object.keys(voices)) {
      const id = String(data.voices[who] || '').trim();
      if (!/^[a-z0-9_-]{8,100}$/i.test(id)) throw new Error('Enter a valid voice ID for ' + who + '.');
      selected[who] = id;
    }
  }
  return {
    apiKey, model, voices: selected, enabled: data.enabled === undefined ? previous.enabled : Boolean(data.enabled),
    speed: data.speed === undefined ? previous.speed : Math.max(0.8, Math.min(1.4, Number(data.speed) || 1.12)),
  };
}

export function fishStatus(config, admin = false) {
  const {model, enabled, speed, voices} = config;
  const ready = Object.fromEntries(Object.entries(voices).map(([who, id]) => [who, Boolean(id)]));
  return {configured: Boolean(config.apiKey), enabled, ...(admin ? {model, speed, voices, ready} : {})};
}

export async function fishSpeech(fetchImpl, config, data, signal) {
  const apiKey = normalizeApiKey(config.apiKey, 'Fish Audio API Key');
  const who = Object.hasOwn(performance, data.who) ? data.who : 'rick';
  const {cue, preview} = performance[who];
  const text = String(data.text || preview).slice(0, 1800).replace(/\[[^\]]{0,200}\]/g, '');
  const emotion = emotions.get(data.emotion) || '';
  const payload = {
    text: `${cue} ${emotion} ${text}`, format: 'mp3', reference_id: config.voices[who],
    prosody: {speed: config.speed, volume: 0, normalize_loudness: true},
    chunk_length: 100, normalize: true, temperature: 0.7,
  };
  const response = await fetchWithoutRedirect(fetchImpl, 'https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', model: config.model},
    body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  });
  if (response.ok) return response;
  await response.body?.cancel();
  throw new Error(`Fish Audio ${response.status}: 语音服务请求失败。`);
}
