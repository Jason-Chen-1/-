import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmdImageError, amdImageMaxReferences, amdImageRatios, downloadAmdImage, normalizeAmdImageRequest, queryAmdImage, submitAmdImage } from './amd-image.mjs';

const origin = 'https://h3.oneclickamd.ai';
const key = 'fixture-private-key';
const taskId = 'a054377657dc4c1f9130144919128106';
const signature = 'fixture-signature';
const url = `${origin}/v1/files/download?exp=1799999999&sig=${signature}`;
const image = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5zsAAAAASUVORK5CYII=', 'base64'));
const model = 'Qwen-Image-2.1-Turbo';
const firstReference = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
const secondReference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('submits a single text prompt using the fixed Turbo model, eight steps, and standard quality', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, `${origin}/v2/video_generation`);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      model, content: [{ type: 'text', text: '猫咪主题海报的主视觉' }], aspect_ratio: '3:4', steps: 8, quality: 'standard',
    });
    return Response.json({ task_id: taskId });
  });
  assert.equal(await submitAmdImage({ key, prompt: ' 猫咪主题海报的主视觉 ', aspectRatio: '3:4', model: 'MiniMax-H3-Image', steps: 30, quality: 'hd' }), taskId);
  assert.equal(fetch.mock.callCount(), 1);
});

test('sends one to three ordered PNG references as edits to the same Turbo task route', async t => {
  const batches = [[firstReference], [secondReference, firstReference, secondReference]];
  const expected = [...batches];
  const fetch = t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, `${origin}/v2/video_generation`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { model, aspect_ratio: '4:3', steps: 8, quality: 'standard', content: [
      { type: 'text', text: '移走云层，保留猫咪。' },
      ...expected.shift().map(url => ({ type: 'image_url', role: 'reference', image_url: { url } })),
    ] });
    return Response.json({ task_id: taskId });
  });
  assert.equal(amdImageMaxReferences, 3);
  assert.deepEqual(amdImageRatios, ['1:1', '4:3', '3:4', '16:9', '9:16']);
  for (const referenceImages of batches) {
    const normalized = normalizeAmdImageRequest({ prompt: '移走云层，保留猫咪。', aspectRatio: '4:3', referenceImages });
    assert.deepEqual(normalized.referenceImages, referenceImages);
    assert.equal(await submitAmdImage({ key, ...normalized }), taskId);
  }
  assert.equal(fetch.mock.callCount(), 2);
});

test('distinguishes pending and terminal v2 task states and reads the signed PNG URL', async t => {
  const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
  t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, `${origin}/v2/query/video_generation/${taskId}`);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    const status = statuses.shift();
    return Response.json({ task: { id: taskId, model, status, modality: 'image', x_steps: status === 'queued' ? null : 8,
      content: { type: 'image', url }, duration: 1 } });
  });
  assert.deepEqual(await queryAmdImage({ key, taskId }), { status: 'pending' });
  assert.deepEqual(await queryAmdImage({ key, taskId }), { status: 'pending' });
  assert.deepEqual(await queryAmdImage({ key, taskId }), { status: 'succeeded', url });
  assert.deepEqual(await queryAmdImage({ key, taskId }), { status: 'failed' });
  assert.deepEqual(await queryAmdImage({ key, taskId }), { status: 'failed' });
});

test('never accepts another model or non-Turbo steps returned for a task', async t => {
  const results = [{ model: 'MiniMax-H3-Image', x_steps: 6 }, { model: 'Qwen-Image-2.1', x_steps: 30 }, { model, x_steps: 30 }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ task: { id: taskId, modality: 'image', status: 'succeeded',
    content: { type: 'image', url }, ...results.shift() } }));
  for (let index = 0; index < 3; index++) await assert.rejects(queryAmdImage({ key, taskId }), { code: 'invalid-response' });
});

test('downloads the signed PNG without an authorization header', async t => {
  t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, url);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.Authorization, undefined);
    return new Response(image, { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  assert.deepEqual(await downloadAmdImage({ url }), { bytes: image, mime: 'image/png' });
});

test('rejects unsigned links, upstream redirects, and untrusted endpoints', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { Location: `https://fixture.invalid/asset?sig=${signature}` },
  }));
  for (const candidate of [
    url.replace('https:', 'http:'), url.replace('h3.oneclickamd.ai', 'h3.oneclickamd.ai.fixture.invalid'),
    url.replace('/v1/files/download', '/v1/tasks'), `${origin}/v1/files/download`,
    url.replace('https://', 'https://name:password@'),
  ]) await assert.rejects(downloadAmdImage({ url: candidate }), { code: 'invalid-download' });
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(downloadAmdImage({ url }), error => {
    assert.equal(error.code, 'invalid-download');
    assert.equal(error.status, 302);
    assert.doesNotMatch(error.message, new RegExp(signature));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('bounds streamed image bytes and rejects a truncated PNG', async t => {
  const part = new Uint8Array(1024 * 1024);
  let cancelled = false;
  const download = new ReadableStream({
    pull(controller) { controller.enqueue(part); }, cancel() { cancelled = true; },
  });
  const results = [new Response(download), new Response(image.subarray(0, image.length - 1))];
  t.mock.method(globalThis, 'fetch', async () => results.shift());
  await assert.rejects(downloadAmdImage({ url }), { code: 'image-too-large' });
  assert.equal(cancelled, true);
  await assert.rejects(downloadAmdImage({ url }), { code: 'invalid-image' });
});

test('reports safe errors and distinguishes retryable polling from an unconfirmed submission', async t => {
  const results = [
    Response.json({ error: { message: `Bearer ${key}` }, request_id: 'req_diagnostic' }, { status: 402 }),
    new Response(null, { status: 503 }), new Response(null, { status: 503 }),
    Response.json({ task_id: `https://fixture.invalid/?sig=${signature}` }),
  ];
  t.mock.method(globalThis, 'fetch', async () => results.shift());
  await assert.rejects(submitAmdImage({ key, prompt: 'poster' }), error => {
    assert.ok(error instanceof AmdImageError);
    assert.equal(error.code, 'insufficient-credits');
    assert.equal(error.status, 402);
    assert.equal(error.requestId, 'req_diagnostic');
    assert.doesNotMatch(error.message, new RegExp(key));
    return true;
  });
  await assert.rejects(queryAmdImage({ key, taskId }), { code: 'unavailable', retryable: true });
  await assert.rejects(submitAmdImage({ key, prompt: 'poster' }), { code: 'unconfirmed-submission', retryable: false });
  await assert.rejects(submitAmdImage({ key, prompt: 'poster' }), { code: 'unconfirmed-submission', retryable: false });
});

test('invalid input and an already cancelled request do not contact AMD', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network call'));
  await assert.rejects(submitAmdImage({ key, prompt: 'poster', aspectRatio: '2:3' }), { code: 'invalid-input' });
  await assert.rejects(submitAmdImage({ key, prompt: '🖼'.repeat(8001) }), { code: 'invalid-input' });
  await assert.rejects(queryAmdImage({ key, taskId: '../tasks' }), { code: 'invalid-input' });
  await assert.rejects(queryAmdImage({ taskId }), { code: 'missing-key' });
  await assert.rejects(queryAmdImage({ key, taskId, signal: AbortSignal.abort() }), { code: 'cancelled' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('excludes unsupported ratios, remote references, malformed PNGs and a fourth reference before calling AMD', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network call'));
  for (const options of [
    { aspectRatio: '21:9' },
    { referenceImages: firstReference },
    { referenceImages: [firstReference, firstReference, firstReference, firstReference] },
    { referenceImages: ['https://fixture.invalid/reference.png'] },
    { referenceImages: [firstReference.replace('image/png', 'image/jpeg')] },
    { referenceImages: ['data:image/png;base64,iVBORw0KGgoAA==='] },
    { referenceImages: [`data:image/png;base64,${Buffer.from(image.subarray(0, image.length - 1)).toString('base64')}`] },
  ]) await assert.rejects(submitAmdImage({ key, prompt: 'poster', ...options }), { code: 'invalid-input' });
  assert.equal(fetch.mock.callCount(), 0);
});
