// An original twelve-bar swing loop.
const score = [
  { bass: [41, 48, 45, 44], chords: [[57, 60, 62, 65]], melody: [[.5, 69], [1, 72], [2, 74], [2.5, 72], [3.5, 69]] },
  { bass: [38, 45, 48, 42], chords: [[54, 60, 63, 69]], melody: [[0, 66], [1.5, 69], [2, 72], [3, 75]] },
  { bass: [43, 50, 53, 52], chords: [[53, 58, 62, 69]], melody: [[.5, 74], [1.5, 70], [2, 69], [3.5, 67]] },
  { bass: [36, 43, 46, 40], chords: [[52, 58, 62, 69]], melody: [[0, 64], [1, 67], [1.5, 70], [2.5, 69], [3, 67]] },
  { bass: [41, 45, 48, 49], chords: [[53, 57, 62, 67]], melody: [[.5, 69], [1, 72], [2.5, 77], [3.5, 74]] },
  { bass: [38, 42, 45, 46], chords: [[54, 60, 64, 69]], melody: [[0, 72], [1.5, 69], [2, 66], [3.5, 69]] },
  { bass: [43, 46, 50, 52], chords: [[53, 58, 62, 69]], melody: [[.5, 70], [1, 74], [2, 77], [2.5, 74], [3.5, 70]] },
  { bass: [36, 40, 43, 44], chords: [[52, 58, 62, 67]], melody: [[0, 76], [1.5, 72], [2.5, 67], [3.5, 69]] },
  { bass: [46, 41, 45, 46], chords: [[53, 57, 62, 65]], melody: [[0, 70], [1.5, 77], [2, 76], [3, 74]] },
  { bass: [47, 41, 44, 48], chords: [[53, 56, 59, 62]], melody: [[.5, 71], [1, 74], [2, 77], [3.5, 71]] },
  { bass: [45, 41, 38, 42], chords: [[53, 57, 60, 62], [54, 60, 63, 69]], melody: [[0, 72], [1, 69], [2.5, 66], [3.5, 69]] },
  { bass: [43, 50, 36, 40], chords: [[53, 58, 62, 65], [52, 58, 62, 69]], melody: [[0, 70], [1.5, 74], [2.5, 72], [3.5, 64]] },
];
const sampleRate = 22050;
const beatSeconds = 60 / 116;
const positionKey = 'crazy-pm.music-position.v1';
const timbres = {
  bass: { duration: .43, attack: .011, decay: 7, harmonics: [1, .31, .09] },
  keys: { duration: .33, attack: .009, decay: 12, harmonics: [.68, .29, .11, .06] },
  pluck: { duration: .41, attack: .006, decay: 10, harmonics: [.8, .37, .21, .07] },
};

function renderLoop(context) {
  const buffer = context.createBuffer(1, Math.round(score.length * 4 * beatSeconds * sampleRate), sampleRate);
  const samples = buffer.getChannelData(0);
  const noteCache = new Map();

  function note(instrument, midi) {
    const key = `${instrument}:${midi}`;
    if (noteCache.has(key)) return noteCache.get(key);
    const { duration, attack, decay, harmonics } = timbres[instrument];
    const sound = new Float32Array(Math.round(duration * sampleRate));
    const angularFrequency = 2 * Math.PI * 440 * 2 ** ((midi - 69) / 12);
    for (let index = 0; index < sound.length; index++) {
      const time = index / sampleRate;
      const phase = angularFrequency * time;
      const envelope = Math.min(1, time / attack, (duration - time) / .035) * Math.exp(-time * decay);
      let wave = 0;
      for (let harmonic = 0; harmonic < harmonics.length; harmonic++) {
        wave += harmonics[harmonic] * Math.sin(phase * (harmonic + 1));
      }
      sound[index] = wave * envelope;
    }
    noteCache.set(key, sound);
    return sound;
  }

  function add(sound, beat, amplitude) {
    const swung = beat % 1 === .5 ? beat + .15 : beat;
    const position = Math.round(swung * beatSeconds * sampleRate);
    for (let index = 0; index < sound.length; index++) {
      samples[(position + index) % samples.length] += sound[index] * amplitude;
    }
  }

  let seed = 71;
  let filter = 0;
  const brush = new Float32Array(Math.round(sampleRate * .14));
  for (let index = 0; index < brush.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 0x80000000 - 1;
    filter += (noise - filter) * .35;
    brush[index] = (noise - filter) * Math.min(1, index / 80) * (1 - index / brush.length) ** 3;
  }

  score.forEach(({ bass, chords, melody }, bar) => {
    const beat = bar * 4;
    bass.forEach((midi, index) => add(note('bass', midi), beat + index, index % 2 ? .11 : .17));
    [1.5, 3].forEach((offset, index) => {
      chords[Math.min(index, chords.length - 1)].forEach((midi, voice) =>
        add(note('keys', midi), beat + offset + .018 * voice + (offset % 1 && voice ? .15 : 0), .035));
    });
    melody.forEach(([offset, midi], index) => add(note('pluck', midi), beat + offset, index ? .135 : .17));
    for (const offset of [1, 2.5, 3]) add(brush, beat + offset, offset === 2.5 ? .028 : .066);
  });
  return buffer;
}

export function createBackgroundMusic(context) {
  const bus = context.createGain();
  bus.gain.value = 0;
  bus.connect(context.destination);
  let track;
  let loopDuration;
  let startedAt;
  let startPosition = 0;
  let level = 0;

  function setLevel(value, immediate = false) {
    if (level === value && !immediate) return;
    if (value > 0 && !track) {
      const buffer = renderLoop(context);
      loopDuration = buffer.duration;
      try {
        const saved = Number(sessionStorage.getItem(positionKey));
        if (Number.isFinite(saved) && saved >= 0) startPosition = saved % loopDuration;
      } catch { /* Playback can begin at the first bar when storage is unavailable. */ }
      track = context.createBufferSource();
      track.buffer = buffer;
      track.loop = true;
      track.connect(bus);
      startedAt = context.currentTime;
      track.start(startedAt, startPosition);
    }
    level = value;
    const now = context.currentTime;
    if (typeof bus.gain.cancelAndHoldAtTime === 'function') bus.gain.cancelAndHoldAtTime(now);
    else bus.gain.cancelScheduledValues(now);
    if (immediate) bus.gain.setValueAtTime(level, now);
    else bus.gain.setTargetAtTime(level, now, .055);
  }

  return {
    setLevel,
    savePosition() {
      if (!track) return;
      const position = (startPosition + Math.max(0, context.currentTime - startedAt)) % loopDuration;
      try { sessionStorage.setItem(positionKey, String(position)); } catch { /* No storage is required for playback. */ }
    },
    destroy() {
      track?.stop();
      track?.disconnect();
      bus.disconnect();
    },
  };
}
