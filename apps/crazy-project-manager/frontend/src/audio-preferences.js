const storageKey = 'crazy-pm.preferences';
const defaults = {
  muted: false,
  volume: .9,
  musicEnabled: true,
  musicVolume: .22,
  effectsEnabled: true,
  effectsVolume: .9,
};
const listeners = new Set();

function normalize(key, value) {
  if (typeof defaults[key] === 'boolean') return typeof value === 'boolean' ? value : defaults[key];
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : defaults[key];
}

function parsePreferences(raw) {
  let stored;
  try { stored = JSON.parse(raw); } catch { /* Invalid storage uses the audio defaults. */ }
  return Object.fromEntries(Object.keys(defaults).map(key => [
    key, normalize(key, key === 'effectsVolume' ? stored?.effectsVolume ?? stored?.volume : stored?.[key]),
  ]));
}

let stored;
try { stored = globalThis.localStorage?.getItem(storageKey); } catch { /* Preferences still work in memory. */ }
let preferences = parsePreferences(stored);

export function getAudioPreferences() {
  return preferences;
}

export function subscribeAudioPreferences(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAudioPreference(key, value) {
  if (!Object.hasOwn(defaults, key)) return;
  const normalized = normalize(key, value);
  if (preferences[key] === normalized) return;
  preferences = { ...preferences, [key]: normalized };
  try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Use the current preference in memory. */ }
  for (const listener of listeners) listener(preferences, { name: key, value: normalized });
}

globalThis.addEventListener?.('storage', event => {
  if (event.storageArea !== globalThis.localStorage || (event.key !== storageKey && event.key !== null)) return;
  const next = parsePreferences(event.newValue);
  if (Object.keys(defaults).every(key => next[key] === preferences[key])) return;
  preferences = next;
  for (const listener of listeners) listener(preferences);
});
