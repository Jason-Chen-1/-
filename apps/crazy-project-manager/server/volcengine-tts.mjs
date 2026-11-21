import { decodeBase64, joinBytes } from './voice-bytes.mjs';

export const volcengineResourceId = 'seed-tts-2.0';
const completedCode = 20_000_000;
const audioLimit = 1_280_000;
const frameLimit = 4 * Math.ceil(audioLimit / 3) + 4096;

const delivery = {
  zhou: '用普通话说出台词。周总用沉着的中低男声，起音果断，断句干脆，句末压低。',
  lin: '用普通话说出台词。林尺用冷静利落的女声，吐字清晰，说到问题位置时稍加重音。',
  tang: '用普通话说出台词。阿唐的男声年轻明亮，语速偏快，强调活动细节时让语调逐渐上扬。',
  yi: '用普通话说出台词。小乙用年轻自然的男声，语气活泼，有一点手忙脚乱的喜感。',
};
const moods = {
  firm: '语气笃定，句尾落稳，像当场拍板。',
  angry: '压着火气，重读反对的理由，收尾果断。',
  sharp: '语句短促，像当场截住话头。',
  point: '语气冷静，说清具体位置和要求再停顿。',
  urgent: '有些着急，读到关键信息时往前赶半拍。',
  excited: '提高声调，语气兴奋，把后半句带起来。',
  ready: '答应得快，声音清亮，有马上开工的劲头。',
  lazy: '压低音量，拖一点尾音，像偷偷刷视频时小声搪塞。',
  startled: '第一声突然提高音调，像被拍桌吓了一跳。后面几句又急又快，有点慌张。',
  confused: '略带迟疑，在问题上抬高尾音。',
  resume: '一下醒了，语速加快，认真地应下。',
  done: '透出松了口气的愉快，尾音轻快。',
};

async function collectAudio(body) {
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  let pending = '';
  let cursor = 0;
  let frameStart = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  function append(record) {
    if (record.length > frameLimit) throw new Error('火山引擎配音响应过大。');
    const frame = JSON.parse(record);
    if (frame?.code === completedCode) return true;
    if (frame?.code !== 0) throw new Error('火山引擎未完成配音。');
    if (frame.data == null || frame.data === '') return;
    if (typeof frame.data !== 'string' || !/^[a-z0-9+/]+={0,2}$/i.test(frame.data)) {
      throw new Error('火山引擎返回了无效音频。');
    }
    const audio = decodeBase64(frame.data);
    if (!audio.length) throw new Error('火山引擎返回了无效音频。');
    bytes += audio.length;
    if (bytes > audioLimit) throw new Error('火山引擎配音响应过大。');
    chunks.push(audio);
  }

  function result() {
    if (bytes < 100) throw new Error('火山引擎没有返回可播放的音频。');
    return joinBytes(chunks, bytes);
  }

  function read(text) {
    pending += text;
    while (cursor < pending.length) {
      const character = pending[cursor++];
      if (depth === 0) {
        if (/\s/u.test(character)) continue;
        if (character !== '{') throw new Error('火山引擎配音响应格式无效。');
        frameStart = cursor - 1;
        depth = 1;
      } else if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') {
        quoted = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}' && --depth === 0) {
        if (append(pending.slice(frameStart, cursor))) return true;
      }
    }
    const consumed = depth ? frameStart : cursor;
    pending = pending.slice(consumed);
    cursor -= consumed;
    frameStart = 0;
    if (pending.length > frameLimit) throw new Error('火山引擎配音响应过大。');
    return false;
  }

  for await (const chunk of body) {
    if (read(decoder.decode(chunk, { stream: true }))) return result();
  }
  if (read(decoder.decode())) return result();
  throw new Error('火山引擎配音响应不完整。');
}

export async function synthesizeVolcengine({ role, mood, text, language, direction }, config, signal) {
  const english = language === 'en';
  const context = english ? `Deliver the line in English. Voice direction: ${direction}.`
    : [delivery[role], moods[mood]].filter(Boolean).join('');
  const additions = { context_texts: [context], ...(english ? { explicit_language: 'en' } : {}) };
  const response = await fetch(config.url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.key,
      'X-Api-Resource-Id': volcengineResourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker: config.voices[role],
        audio_params: { format: 'mp3', sample_rate: 24000 },
        additions: JSON.stringify(additions),
      },
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error('火山引擎配音暂不可用。');
  return collectAudio(response.body);
}
