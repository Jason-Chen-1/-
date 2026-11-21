import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workerVoice } from './voice.mjs';

const app = 'https://studio.example.test';
const fakeKey = 'worker-voice-fixture';
const audio = await readFile(new URL('../dist/assets/voices/mandarin/zhou-6a07da59a548c1.mp3', import.meta.url));

test('Worker 保留已选择的识别服务，即使实时识别当前不可用', async () => {
  const settings = { tts: { mode: 'local' }, asr: { mode: 'volcengine', key: '' } };
  const response = await workerVoice(new Request(app + '/api/speech'), {}, { settings });
  const capabilities = await response.json();
  assert.equal(capabilities.asrMode, 'volcengine');
  assert.equal(capabilities.asrStreaming, undefined);
});

test('Worker 豆包一句话模式保留明确选择并拒绝文件接口', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Sentence mode must not submit a recording-file request'));
  const options = { settings: { tts: { mode: 'local' }, asr: { mode: 'volcengine-sentence', key: fakeKey } } };
  const capabilities = await workerVoice(new Request(app + '/api/speech'), {}, options);
  assert.equal((await capabilities.json()).asrMode, 'volcengine-sentence');
  const response = await workerVoice(new Request(app + '/api/recognition', { method: 'POST' }), {}, options);
  assert.equal(response.status, 405);
  assert.match((await response.json()).error, /WebSocket/);
});

test('Worker 在线 TTS 复用火山协议并向前端返回完整音频和资源引用', async t => {
  const url = 'https://api.example.test/tts';
  const settings = {
    tts: {
      mode: 'volcengine', key: fakeKey, model: 'seed-tts-2.0', url,
      voices: { zhou: 'zh_male_m191_uranus_bigtts' },
    },
    asr: { mode: 'browser' },
  };
  t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, url);
    assert.equal(request.headers['X-Api-Key'], fakeKey);
    assert.equal(JSON.parse(request.body).req_params.speaker, 'zh_male_m191_uranus_bigtts');
    return new Response(JSON.stringify({ code: 0, data: audio.toString('base64') }) +
      '\n' + JSON.stringify({ code: 20_000_000 }));
  });
  let saved;
  const options = { settings, saveMedia: async (bytes, mime) => {
    saved = [Buffer.from(bytes), mime];
    return { hash: 'test-clip', url: '/api/media/test-clip' };
  } };
  const capabilities = await workerVoice(new Request(app + '/api/speech'), {}, options);
  assert.deepEqual(await capabilities.json(), { roles: ['zhou'], synthesis: 'volcengine', asr: false, asrMode: 'browser' });
  const response = await workerVoice(new Request(app + '/api/speech', {
    method: 'POST', body: JSON.stringify({ role: 'zhou', text: '高级一点。', mood: 'firm' }),
  }), {}, options);
  assert.equal(response.headers.get('x-voice-provider'), 'volcengine');
  assert.equal(response.headers.get('x-media-hash'), 'test-clip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.deepEqual(saved, [audio, 'audio/mpeg']);
});

test('Worker 火山标准版用短时音频链接提交与查询，返回最终转写', async t => {
  const upstream = 'https://asr.example.test';
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  let taskId;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const data = JSON.parse(request.body);
    if (url.endsWith('/submit')) {
      taskId = request.headers['X-Api-Request-Id'];
      assert.equal(data.audio.url, app + '/asr/temporary.wav');
      return Response.json({}, { headers: { 'X-Api-Status-Code': '20000000' } });
    }
    assert.equal(url, upstream + '/query');
    assert.equal(request.headers['X-Api-Request-Id'], taskId);
    assert.deepEqual(data, {});
    return Response.json({ result: { text: '把展名放大。' } }, { headers: { 'X-Api-Status-Code': '20000000' } });
  });
  const response = await workerVoice(new Request(app + '/api/recognition', {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav,
  }), {}, {
    settings: {
      tts: { mode: 'local' },
      asr: { mode: 'volcengine', key: fakeKey, url: upstream + '/submit', queryUrl: upstream + '/query' },
    },
    makeAudioUrl: async (buffer, mime) => {
      assert.deepEqual(Buffer.from(buffer), wav);
      assert.equal(mime, 'audio/wav');
      return app + '/asr/temporary.wav';
    },
  });
  assert.deepEqual(await response.json(), { text: '把展名放大。', provider: 'volcengine' });
});
