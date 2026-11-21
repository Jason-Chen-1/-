import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { handleVoice, handleVolcengineASR } from './voice.mjs';

const wav = Buffer.alloc(44 + 640);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);

const fixtureKey = 'recognition-fixture-key';
const success = { code: '20000000', body: { result: { text: '请放大展名。' } } };
const path = '/api/v3/auc/bigmodel';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, mode, responseFor = () => success, makeAudioUrl) {
  const requests = [];
  const host = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { url: req.url, headers: req.headers, data: JSON.parse(Buffer.concat(chunks).toString()) };
    requests.push(request);
    const { code, body = {} } = responseFor(request, requests);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Api-Status-Code': code });
    res.end(JSON.stringify(body));
  });
  const flash = mode === 'volcengine-flash';
  const config = {
    tts: { mode: 'local' },
    asr: {
      mode, key: fixtureKey,
      url: host + path + (flash ? '/recognize/flash' : '/submit'),
      queryUrl: flash ? '' : host + path + '/query',
      resourceId: flash ? 'volc.bigasr.auc_turbo' : 'volc.seedasr.auc',
    },
  };
  const options = { getSettings: () => config, makeAudioUrl };
  const app = await listen(t, (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/speech') return handleVoice(req, res, url, options);
    return handleVolcengineASR(req, res, url, options);
  });
  const ask = (body = wav, mime = 'audio/wav') => fetch(app + '/api/recognition', {
    method: 'POST', headers: { 'Content-Type': mime }, body,
  });
  return { requests, config, ask, app };
}

test('一句话模式保留 WebSocket 能力标识并拒绝录音文件 POST', async t => {
  const { app, ask, requests } = await fixture(t, 'volcengine-sentence');
  assert.deepEqual(await (await fetch(app + '/api/speech')).json(), {
    roles: [], synthesis: 'local', asr: false, asrMode: 'volcengine-sentence', asrStreaming: 'volcengine',
  });
  const uploaded = await ask();
  assert.equal(uploaded.status, 405);
  assert.match((await uploaded.json()).error, /WebSocket/);
  assert.deepEqual(requests, []);
});

test('标准版用短时公开的 WAV 地址提交，复用任务 ID 查询处理中、排队和完成', async t => {
  const published = [];
  const audioUrl = 'https://audio.example.test/record.wav?temporary=1';
  const { requests, ask, app } = await fixture(t, 'volcengine', (request, requests) => {
    if (request.url.endsWith('/submit')) return { code: '20000000' };
    if (requests.length === 2) return { code: '20000001' };
    if (requests.length === 3) return { code: '20000002' };
    return success;
  }, (bytes, mime) => {
    published.push([bytes, mime]);
    return audioUrl;
  });

  const response = await ask();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '请放大展名。', provider: 'volcengine' });
  assert.deepEqual(published.map(([bytes, mime]) => [Buffer.from(bytes), mime]), [[wav, 'audio/wav']]);
  assert.deepEqual(requests.map(request => request.url), [path + '/submit', ...Array(3).fill(path + '/query')]);
  const [submit, ...queries] = requests;
  assert.equal(submit.headers['x-api-key'], fixtureKey);
  assert.equal(submit.headers['x-api-resource-id'], 'volc.seedasr.auc');
  assert.equal(submit.headers['x-api-sequence'], '-1');
  assert.match(submit.headers['x-api-request-id'], /^[a-f0-9-]{36}$/i);
  assert.deepEqual(submit.data.audio, {
    url: audioUrl, format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN',
  });
  for (const request of queries) {
    assert.deepEqual(request.data, {});
    assert.equal(request.headers['x-api-request-id'], submit.headers['x-api-request-id']);
    assert.equal(request.headers['x-api-key'], fixtureKey);
  }
  assert.deepEqual(await (await fetch(app + '/api/speech')).json(), {
    roles: [], synthesis: 'local', asr: false, asrMode: 'volcengine', asrStreaming: 'volcengine',
  });
});

test('标准版接受显式公网音频链接，拒绝仅在本机可访问的录音和无效输入', async t => {
  const { requests, ask } = await fixture(t, 'volcengine');
  assert.equal((await ask()).status, 422);
  assert.equal((await ask(Buffer.from('not WAV'))).status, 400);
  assert.equal((await ask(JSON.stringify({ audioUrl: 'http://127.0.0.1/audio.wav' }), 'application/json')).status, 400);
  assert.equal(requests.length, 0);

  const audioUrl = 'https://audio.example.test/live.mp3';
  assert.equal((await ask(JSON.stringify({ audioUrl }), 'application/json')).status, 200);
  assert.deepEqual(requests[0].data.audio, { url: audioUrl, format: 'mp3', language: 'zh-CN' });
  assert.equal(requests.length, 2);
});

test('极速版内联传输 WAV，不发布地址、不轮询，区分静音', async t => {
  let responseForFlash = success;
  const { requests, ask } = await fixture(t, 'volcengine-flash', () => responseForFlash, () => {
    assert.fail('极速版不应发布公网链接');
  });
  const response = await ask();
  assert.deepEqual(await response.json(), { text: '请放大展名。', provider: 'volcengine-flash' });
  assert.equal(requests[0].url, path + '/recognize/flash');
  assert.equal(requests[0].headers['x-api-resource-id'], 'volc.bigasr.auc_turbo');
  assert.equal(requests[0].data.audio.data, wav.toString('base64'));
  assert.equal(requests[0].data.audio.url, undefined);
  assert.equal(requests.length, 1);

  responseForFlash = { code: '20000003' };
  assert.equal((await ask()).status, 422);
  assert.equal(requests.length, 2);
});
