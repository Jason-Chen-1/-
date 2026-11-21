import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decode, encode } from '@msgpack/msgpack';
import { createStreamingRecognition, recognitionUpgradeError } from './streaming-asr.mjs';

const config = { mode: 'volcengine', key: 'fixture-speech-key', resourceId: 'volc.seedasr.auc' };
const start = JSON.stringify({ type: 'start', sampleRate: 16000, language: 'en-US' });
const end = JSON.stringify({ type: 'end' });

function serverFrame(data, final = false, event) {
  const body = gzipSync(JSON.stringify(data));
  const sizeOffset = event === undefined ? 8 : 12;
  const bytes = Buffer.alloc(sizeOffset + 4 + body.length);
  bytes.set([0x11, (final ? 0x93 : 0x91) | (event === undefined ? 0 : 4), 0x11, 0]);
  bytes.writeInt32BE(final ? -3 : 2, 4);
  if (event !== undefined) bytes.writeInt32BE(event, 8);
  bytes.writeUInt32BE(body.length, sizeOffset);
  body.copy(bytes, sizeOffset + 4);
  return bytes;
}

async function fixture(t, settings = config) {
  const events = [];
  const sent = [];
  let api;
  let protocol;
  const session = createStreamingRecognition(settings, {
    connect(options, callbacks) {
      protocol = options;
      api = callbacks;
      return Promise.resolve({ send: bytes => sent.push(bytes) });
    },
    emit: event => events.push(event),
    close() {},
  });
  t.after(() => session.close());
  session.receive(start, false);
  await new Promise(resolve => setImmediate(resolve));
  return { session, protocol, api, sent, events };
}

test('Volcengine uses the realtime resource, sends draft text before release, then the final transcript', async t => {
  const { session, protocol, api, sent, events } = await fixture(t);
  assert.equal(protocol.url, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async');
  assert.equal(protocol.headers['X-Api-Key'], config.key);
  assert.equal(protocol.headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(sent[0][1], 0x10);
  const options = JSON.parse(gunzipSync(sent[0].subarray(8)));
  assert.deepEqual(options.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  assert.equal(options.request.enable_nonstream, true);

  // Audio received while the provider is starting is forwarded in order after its acknowledgement.
  const firstPCM = Buffer.alloc(6400, 1);
  const tailPCM = Buffer.alloc(1024, 2);
  session.receive(firstPCM, true);
  session.receive(tailPCM, true);
  assert.equal(sent.length, 1);
  api.receive(serverFrame({ code: 20000000 }));
  assert.equal(sent[1][1], 0x20);
  assert.deepEqual(gunzipSync(sent[1].subarray(8)), firstPCM);
  api.receive(serverFrame({ result: { text: 'Move the title', utterances: [{ definite: true }] } }));
  assert.deepEqual(events, [
    { type: 'ready', provider: 'volcengine' },
    { type: 'draft', provider: 'volcengine', text: 'Move the title' },
  ]);

  session.receive(end, false);
  assert.equal(sent[2][1], 0x22);
  assert.deepEqual(gunzipSync(sent[2].subarray(8)), tailPCM);
  api.receive(serverFrame({ result: { text: 'Move the title up.' } }, true));
  api.disconnected();
  assert.deepEqual(events.filter(event => event.type === 'final'), [
    { type: 'final', text: 'Move the title up.', provider: 'volcengine' },
  ]);
});

test('a dropped realtime connection never promotes the draft to a final transcript', async t => {
  const { session, api, events } = await fixture(t);
  api.receive(serverFrame({ code: 20000000 }));
  session.receive(Buffer.alloc(2048), true);
  api.receive(serverFrame({ result: { text: 'partial' } }));
  session.receive(end, false);
  api.disconnected();
  assert.equal(events.at(-1).code, 'incomplete-transcript');
  assert.equal(events.some(event => event.type === 'final'), false);
});

test('豆包一句话模式使用官方带序号帧，松手时才返回整句', async t => {
  const resourceId = 'volc.seedasr.sauc.concurrent';
  const { session, protocol, api, sent, events } = await fixture(t, { ...config, mode: 'volcengine-sentence', resourceId });
  assert.equal(protocol.url, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream');
  assert.equal(protocol.headers['X-Api-Key'], config.key);
  assert.equal(protocol.headers['X-Api-Resource-Id'], resourceId);
  assert.match(protocol.headers['X-Api-Request-Id'], /^[a-f0-9-]{36}$/);
  assert.equal(protocol.headers['X-Api-Sequence'], undefined);
  const incoming = index => Buffer.from(sent[index]);
  const initial = incoming(0);
  assert.deepEqual([...initial.subarray(0, 4)], [0x11, 0x11, 0x11, 0]);
  assert.equal(initial.readInt32BE(4), 1);
  const options = JSON.parse(gunzipSync(initial.subarray(12)));
  assert.deepEqual(options.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  assert.equal(options.request.model_name, 'bigmodel');
  assert.equal(options.request.enable_nonstream, undefined);

  api.receive(serverFrame({ code: 0 }));
  const audio = Buffer.alloc(6400, 1);
  const tail = Buffer.alloc(1024, 2);
  session.receive(audio, true);
  session.receive(tail, true);
  assert.deepEqual([...incoming(1).subarray(0, 4)], [0x11, 0x21, 0x11, 0]);
  assert.equal(incoming(1).readInt32BE(4), 2);
  assert.deepEqual(gunzipSync(incoming(1).subarray(12)), audio);
  api.receive(serverFrame({ result: { text: '把标题', utterances: [{ definite: true }] } }));
  assert.deepEqual(events, [{ type: 'ready', provider: 'volcengine' }]);

  session.receive(end, false);
  assert.deepEqual([...incoming(2).subarray(0, 4)], [0x11, 0x23, 0x11, 0]);
  assert.equal(incoming(2).readInt32BE(4), -3);
  assert.deepEqual(gunzipSync(incoming(2).subarray(12)), tail);
  api.receive(serverFrame({ result: { text: '把标题留在左侧。' } }, true, 0));
  assert.deepEqual(events.slice(1), [{ type: 'final', text: '把标题留在左侧。', provider: 'volcengine' }]);
});

test('豆包一句话权限失败只报告该接口错误', async t => {
  const events = [];
  const endpoints = [];
  const session = createStreamingRecognition({ ...config, mode: 'volcengine-sentence' }, {
    connect: async ({ url }) => {
      endpoints.push(url);
      throw recognitionUpgradeError(403, 'fixture-log');
    },
    emit: event => events.push(event),
    close() {},
  });
  t.after(() => session.close());
  session.receive(start, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(endpoints, ['wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream']);
  assert.equal(events[0].code, 'stream-permission');
  assert.equal(events[0].fallback, undefined);
  assert.equal(events[0].upstreamStatus, 403);
});

test('upstream authorization failure shows the realtime resource requirement with safe diagnostics', async t => {
  const events = [];
  const session = createStreamingRecognition(config, {
    connect: async () => { throw recognitionUpgradeError(403, 'public-log-id'); },
    emit: event => events.push(event),
    close() {},
  });
  t.after(() => session.close());
  session.receive(start, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].code, 'stream-permission');
  assert.equal(events[0].upstreamStatus, 403);
  assert.equal(events[0].logId, 'public-log-id');
  assert.equal(JSON.stringify(events).includes(config.key), false);
});

test('Fish includes committed sentences in live drafts and waits for session_done before submitting', async t => {
  const { session, api, sent, events } = await fixture(t, { mode: 'fish', key: 'fixture', url: 'wss://example.com/asr' });
  assert.equal(decode(sent[0]).results.drafts, true);
  api.receive(encode({ type: 'session_started' }));
  session.receive(Buffer.alloc(1024), true);
  api.receive(encode({ type: 'committed', text: 'First.' }));
  api.receive(encode({ type: 'draft', text: 'Second' }));
  assert.equal(events.at(-1).text, 'First. Second');
  session.receive(end, false);
  assert.equal(decode(sent.at(-1)).type, 'audio_done');
  api.receive(encode({ type: 'committed', text: 'Second.' }));
  assert.equal(events.at(-1).type, 'draft');
  api.receive(encode({ type: 'session_done' }));
  assert.deepEqual(events.at(-1), { type: 'final', text: 'First. Second.', provider: 'fish' });
});
