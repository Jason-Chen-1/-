import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalWorker } from './start-worker.mjs';

function sessionCookie(response) {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

async function readUpdates(response) {
  assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return async (condition) => {
    for (;;) {
      const delimiter = pending.indexOf('\n\n');
      if (delimiter >= 0) {
        const frame = pending.slice(0, delimiter);
        pending = pending.slice(delimiter + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
        if (data.length) {
          const update = JSON.parse(data.join('\n'));
          if (condition(update)) return update;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
    }
    throw new Error('SSE 在目标事件出现之前关闭。');
  };
}

async function until(poll, condition) {
  for (let attempt = 0; attempt < 85; attempt += 1) {
    const value = await poll();
    if (condition(value)) return value;
    await delay(130);
  }
  throw new Error('Worker 会话状态没有在测试时间内更新。');
}

await import('./build-worker.mjs');
const dataDirectory = await mkdtemp(path.join(tmpdir(), 'studio-worker-smoke-'));
const upstreamUrl = 'https://studio-model.example.test/v1/chat/completions';
const voiceUrl = 'https://studio-voice.example.test';
const audioUrl = 'https://studio-audio.example.test/recording.mp3';
const audio = Buffer.alloc(180, 9);
let recognitionId;
const reviewRequests = [];
const upstreamErrors = [];
const firstReview = Promise.withResolvers();
const releaseReview = Promise.withResolvers();
const settings = {
  port: 0, dataDirectory,
  bindings: {
    STUDIO_AGENT_MODE: 'api', STUDIO_MODEL_URL: upstreamUrl, STUDIO_MODEL: 'fixture', STUDIO_VISION_MODE: 'inherit',
    STUDIO_TTS_MODE: 'volcengine', VOLCENGINE_TTS_URL: `${voiceUrl}/speech`, VOLCENGINE_API_KEY: 'fixture-tts',
    STUDIO_ASR_MODE: 'volcengine', VOLCENGINE_ASR_API_KEY: 'fixture-asr',
    VOLCENGINE_ASR_URL: `${voiceUrl}/submit`, VOLCENGINE_ASR_QUERY_URL: `${voiceUrl}/query`
  },
  async outboundService(request) {
    try {
      if (request.url === `${voiceUrl}/speech`) {
        const { req_params: params } = await request.json();
        assert.equal(request.headers.get('X-Api-Key'), 'fixture-tts');
        assert.match(JSON.parse(params.additions).context_texts[0], /周总.*压着火气/);
        return new Response(JSON.stringify({ code: 0, data: audio.toString('base64') }) + '\n' + JSON.stringify({ code: 20000000 }));
      }
      const recognitionHeaders = { 'X-Api-Status-Code': '20000000' };
      if (request.url === `${voiceUrl}/submit`) {
        const input = await request.json();
        assert.equal(request.headers.get('X-Api-Resource-Id'), 'volc.seedasr.auc');
        assert.equal(request.headers.get('X-Api-Key'), 'fixture-asr');
        assert.equal(input.audio.url, audioUrl);
        recognitionId = request.headers.get('X-Api-Request-Id');
        assert.ok(recognitionId);
        return Response.json({}, { headers: recognitionHeaders });
      }
      if (request.url === `${voiceUrl}/query`) {
        assert.equal(request.headers.get('X-Api-Request-Id'), recognitionId);
        return Response.json({ result: { text: '把展名放大。' } }, { headers: recognitionHeaders });
      }
      assert.equal(request.url, upstreamUrl);
      const { messages } = await request.json();
      const { content } = messages[1];
      assert.ok(Array.isArray(content), '视觉请求应包含文本与图像');
      const input = JSON.parse(content[0].text);
      reviewRequests.push({ role: input.role, version: input.version, image: content[1].image_url.url });
      if (reviewRequests.length === 1) {
        firstReview.resolve();
        await releaseReview.promise;
      }
      const output = { role: input.role, text: '手机预览时看清标题。', mood: 'firm', elementIds: ['title'] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
    } catch (error) {
      upstreamErrors.push(error.message);
      throw error;
    }
  }
};
let active = await startLocalWorker(settings);
const stream = new AbortController();
let cookie = '';

function fetchRoute(route, { body, auth = true, signal = AbortSignal.timeout(15000), ...options } = {}) {
  const headers = new Headers(options.headers);
  if (auth && cookie) headers.set('Cookie', cookie);
  if (body) headers.set('Content-Type', 'application/json');
  return fetch(new URL(route, active.address), { ...options, method: body ? 'POST' : 'GET', signal, headers, body: body ? JSON.stringify(body) : undefined });
}

async function load(route, options) {
  const response = await fetchRoute(route, options);
  const body = await response.json();
  assert.ok(response.ok, body.error || `HTTP ${response.status}`);
  return body;
}

try {
  const home = await fetchRoute('/');
  assert.equal(home.status, 200);
  const page = await home.text();
  assert.match(page, /疯狂的项目经理/);
  const entry = /src="(\/assets\/home-[^"]+\.js)"/.exec(page)?.[1];
  assert.ok(entry, 'Worker 首页应使用 Vite 构建的 React 入口');
  const bundle = await fetchRoute(entry);
  assert.equal(bundle.status, 200);
  await bundle.arrayBuffer();
  for (const [route, marker] of [['/recognition-worklet.js', 'registerProcessor'], ['/replay-player.js', 'mountReplay'], ['/replay.css', 'replay-shell']]) {
    const asset = await fetchRoute(route);
    assert.equal(asset.status, 200, route);
    assert.ok((await asset.text()).includes(marker), route);
  }
  for (const [route, mime] of [['/assets/characters/rick.png', 'image/png'], ['/assets/voices/aside1.mp3', 'audio/mpeg']]) {
    const asset = await fetchRoute(route, { headers: { Range: 'bytes=0-7' } });
    assert.equal(asset.status, 206, route);
    assert.equal(asset.headers.get('Content-Type'), mime);
    assert.equal((await asset.arrayBuffer()).byteLength, 8);
  }
  cookie = sessionCookie(home);
  const services = await load('/api/settings');
  assert.equal(services.writable, false);
  assert.ok(!JSON.stringify(services).includes('fixture-tts') && !JSON.stringify(services).includes('fixture-asr'));
  const speech = await fetchRoute('/api/speech', { body: { role: 'zhou', text: '标题要够大。', mood: 'angry' } });
  assert.equal(speech.status, 200, await speech.clone().text());
  assert.equal(speech.headers.get('X-Voice-Provider'), 'volcengine');
  assert.deepEqual(Buffer.from(await speech.arrayBuffer()), audio);
  const recognition = await load('/api/recognition', { body: { audioUrl } });
  assert.equal(recognition.text, '把展名放大。');
  const creation = await fetchRoute('/api/sessions', { body: {} });
  assert.ok(creation.ok, await creation.clone().text());
  cookie = sessionCookie(creation) || cookie;
  assert.ok(cookie, 'Worker 首次访问应设置访客 Cookie');
  const session = await creation.json();
  assert.ok(session.id);
  const endpoint = `/api/sessions/${session.id}`;
  assert.equal((await fetchRoute(endpoint, { auth: false })).status, 404);
  assert.equal((await load(endpoint)).selectedVersionId, 'V01');

  const source = await fetchRoute(`${endpoint}/events?after=${session.seq}`, {
    signal: AbortSignal.any([stream.signal, AbortSignal.timeout(18000)])
  });
  const update = await readUpdates(source);
  const initialUpdate = await update(() => true);
  assert.equal(initialUpdate.state.mode, 'online');
  const command = (type, payload) => load(`${endpoint}/commands`, { body: { id: crypto.randomUUID(), type, payload } });
  await Promise.race([firstReview.promise, delay(7000).then(async () => {
    const { reviewRounds } = await load(endpoint);
    throw new Error(`Worker 未调用视觉模型。${JSON.stringify({ reviewRounds, upstreamErrors })}`);
  })]);
  const assignment = { id: crypto.randomUUID(), type: 'assign', payload: { text: '把免费须预约做成标题旁的大黄贴，盖住半个馆标', baseVersionId: 'V01' } };
  const assigned = await Promise.all(Array.from({ length: 2 }, () => load(`${endpoint}/commands`, { body: assignment })));
  assert.deepEqual(assigned.map(item => Boolean(item.duplicate)).sort(), [false, true]);
  releaseReview.resolve();
  await update((item) => item.events?.some((event) => event.type === 'job-started'));
  await until(() => load(endpoint), (state) => state.job?.status === 'paused');
  await command('nudge', { source: 'button' });
  const revised = await until(() => load(endpoint), (state) => state.selectedVersionId === 'V02');
  assert.deepEqual(Object.values(revised.versions.at(-1).review).map((review) => review.score), [80, 65, 100]);
  const reviewed = await until(() => load(endpoint), (state) => state.reviewRounds.length === 2 && state.reviewRounds.every(round => round.status === 'completed'));
  for (const round of reviewed.reviewRounds) {
    assert.deepEqual(round.pngReaders.slice().sort(), ['lin', 'tang', 'zhou']);
    const images = reviewRequests.filter(request => request.version === round.versionId);
    assert.deepEqual(images.map(request => request.role).sort(), ['lin', 'tang', 'zhou']);
    assert.ok(images.every(request => request.image.startsWith('data:image/png;base64,iVBORw0KGgo')));
  }

  const delivery = await command('export', { versionId: 'V02', format: 'png' });
  const poster = await fetchRoute(delivery.result.url);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('Content-Type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await poster.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await load(endpoint)).selectedVersionId, 'V02');

  stream.abort();
  await active.studio.dispose();
  active = await startLocalWorker(settings);
  const reloaded = await load(endpoint);
  assert.equal(reloaded.selectedVersionId, 'V02');
  assert.equal(reloaded.deliveries.at(-1).hash, delivery.result.hash);
  const persistedPoster = await fetchRoute(delivery.result.url);
  assert.equal(persistedPoster.status, 200);
  assert.equal(persistedPoster.headers.get('Content-Type'), 'image/png');
  await persistedPoster.arrayBuffer();
  console.log('Worker smoke 已通过访客隔离、豆包 TTS/ASR、SSE 派工去重、拍桌复工、并发 PNG 评审、交付和 D1/R2 重启持久化。');
} finally {
  releaseReview.resolve();
  stream.abort();
  await active.studio.dispose();
}
