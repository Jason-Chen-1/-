import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { handleVoice } from './voice.mjs';

const voices = {
  zhou: 'zh_male_m191_uranus_bigtts',
  lin: 'zh_female_xiaohe_uranus_bigtts',
  tang: 'zh_male_yangguangqingnian_uranus_bigtts',
  yi: 'zh_male_taocheng_uranus_bigtts',
};
const audio = await readFile(new URL('../dist/assets/voices/mandarin/zhou-6a07da59a548c1.mp3', import.meta.url));
const audioFrame = bytes => ({ code: 0, data: bytes.toString('base64') });
const finishFrame = { code: 20_000_000, data: null };

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, upstream, storeMedia) {
  const host = await listen(t, upstream);
  const config = {
    tts: { mode: 'volcengine', url: host + '/api/v3/tts/unidirectional', key: 'fixture-volcengine-key', model: 'seed-tts-2.0', voices },
    asr: { mode: 'browser' },
  };
  const app = await listen(t, (req, res) => handleVoice(req, res, new URL(req.url, 'http://local'), {
    getSettings: () => config,
    storeMedia,
  }));
  const url = app + '/api/speech';
  const ask = text => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'yi', mood: 'startled', text }),
  });
  return { ask, url, config };
}

test('火山引擎使用四角色配置，解析跨块 JSON 并缓存完整 MP3', async t => {
  const requests = [];
  const hashes = [];
  const { ask, url, config } = await fixture(t, async (req, res) => {
    const input = [];
    for await (const chunk of req) input.push(chunk);
    requests.push({ url: req.url, headers: req.headers, payload: JSON.parse(Buffer.concat(input).toString()) });
    const boundary = Math.floor(audio.length / 2);
    const metadata = { code: 0, data: null, sentence: { text: '受惊配音在引号里有 "}{" 字符' } };
    const frames = Buffer.from(
      JSON.stringify(audioFrame(audio.subarray(0, boundary))) + '\r\n'
      + JSON.stringify(metadata, null, 2) + JSON.stringify(audioFrame(audio.subarray(boundary)))
      + JSON.stringify(finishFrame),
    );
    const utf8Split = frames.indexOf('受惊') + 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(frames.subarray(0, 72));
    await wait(10);
    res.write(frames.subarray(72, utf8Split));
    await wait(10);
    res.end(frames.subarray(utf8Split));
  }, (bytes, mime) => {
    assert.deepEqual(bytes, audio);
    assert.equal(mime, 'audio/mpeg');
    const hash = createHash('sha256').update(bytes).digest('hex');
    hashes.push(hash);
    return { hash, url: '/api/media/' + hash };
  });

  assert.deepEqual(await (await fetch(url)).json(), { roles: Object.keys(voices), synthesis: 'volcengine', asr: false, asrMode: 'browser' });
  const text = '哇！咖啡差点飞了！';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await ask(text);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('x-voice-provider'), 'volcengine');
    assert.equal(response.headers.get('x-media-hash'), hashes.at(-1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  }

  assert.equal(requests.length, 1);
  const [{ url: path, headers, payload }] = requests;
  assert.equal(path, '/api/v3/tts/unidirectional');
  assert.equal(headers['x-api-key'], config.tts.key);
  assert.equal(headers['x-api-resource-id'], 'seed-tts-2.0');
  assert.match(headers['x-api-request-id'], /^[a-f0-9-]{36}$/i);
  const { additions, ...params } = payload.req_params;
  assert.deepEqual(params, { text, speaker: voices.yi, audio_params: { format: 'mp3', sample_rate: 24000 } });
  assert.match(JSON.parse(additions).context_texts[0], /小乙.*拍桌吓了一跳/);
  config.tts.model = 'seed-tts-1.0';
  assert.equal((await ask(text)).status, 503);
  assert.equal(requests.length, 1);
});

test('火山引擎仅交付完整的成功音频，失败允许页面降级到本地', async t => {
  let responseType = 'denied';
  const { ask } = await fixture(t, (req, res) => {
    req.resume();
    if (responseType === 'truncated') {
      res.end(JSON.stringify(audioFrame(audio)) + '{"code":');
      return;
    }
    const end = {
      denied: { code: 45_000_000, message: 'upstream-only-detail', data: null },
      malformed: { code: 0, data: '?' },
      empty: finishFrame,
    }[responseType];
    const frames = responseType === 'empty' ? [end] : [audioFrame(audio), end];
    res.end(frames.map(value => JSON.stringify(value)).join('\n'));
  }, () => assert.fail('失败的音频不应被保存'));
  for (const type of ['denied', 'malformed', 'empty', 'truncated']) {
    responseType = type;
    const response = await ask('这句需要本地配音' + type);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: '在线配音暂不可用。' });
  }
});
