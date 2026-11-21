import { getAudioPreferences, subscribeAudioPreferences } from './audio-preferences.js';
import { createBackgroundMusic } from './workbench/background-music.js';

export function mountHomeMusic() {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Audio) return;
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  let context;
  let music;
  let unavailable = false;

  function sync() {
    if (signal.aborted || unavailable || context?.state !== 'running') return;
    const { muted, musicEnabled, musicVolume } = getAudioPreferences();
    const silent = muted || document.hidden;
    const level = silent || !musicEnabled ? 0 : musicVolume;
    try {
      if (!music && level > 0) music = createBackgroundMusic(context);
      music?.setLevel(level, silent);
    } catch {
      unavailable = true;
      music?.destroy();
      music = undefined;
    }
  }

  function start(event) {
    if (!event.isTrusted || unavailable) return;
    try {
      if (!context) context = new Audio();
      if (context.state === 'running') sync();
      else void context.resume().then(sync).catch(() => {});
    } catch {
      unavailable = true;
    }
  }

  for (const type of ['pointerdown', 'pointerup', 'keydown', 'click']) {
    document.addEventListener(type, start, { capture: true, signal });
  }
  const unsubscribe = subscribeAudioPreferences(sync);
  document.addEventListener('visibilitychange', sync, { signal });
  window.addEventListener('pageshow', sync, { signal });
  window.addEventListener('pagehide', () => {
    music?.savePosition();
    music?.setLevel(0, true);
  }, { signal });
  return () => {
    lifecycle.abort();
    unsubscribe();
    music?.destroy();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
}
