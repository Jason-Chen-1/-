import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { createStudioServer } from '../server.mjs';

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

async function listener(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function studioFixture(t) {
  const root = path.resolve(tmpdir());
  const prefix = 'yifang-options-test-';
  const dir = await mkdtemp(path.join(root, prefix));
  const envFile = path.join(dir, '.env');
  await writeFile(envFile, '# test configuration\nKEEP_LOCAL_SETTING=same\n');
  const studio = createStudioServer({ dataDirectory: dir, envFile, settingsEnv: {}, stepMs: 16 });
  const origin = await listener(studio.server);
  t.after(async () => {
    await studio.close();
    if (path.dirname(dir) === root && path.basename(dir).startsWith(prefix)) await rm(dir, { recursive: true });
  });
  return { origin, envFile };
}

test('首页保留多个项目，自定义主题生成专属 V01 与三位甲方首轮需求', async t => {
  const { origin } = await studioFixture(t);
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="root"|历史项目/);
  const project = { topic: '城市植物交换节', brief: '鼓励居民交换盆栽', organizer: '春日协会', date: '周六 14:00', venue: '城市庭院' };
  const created = await post(`${origin}/api/sessions`, { project });
  assert.equal(created.status, 201);
  const state = await created.json();
  assert.equal(state.theme.name, project.topic);
  assert.equal(state.versions[0].id, 'V01');
  assert.deepEqual(state.lastDialogue.map(line => line.role), ['zhou', 'lin', 'tang']);
  assert.ok(state.lastDialogue.every(line => line.requirement?.instruction && line.elementIds.length));
  const svg = await (await fetch(`${origin}/api/sessions/${state.id}/versions/V01/poster.svg`)).text();
  assert.match(svg, /<title>城市植物交换节<\/title>/);
  assert.match(svg, /城市庭院/);
  assert.doesNotMatch(svg, /夜游美术馆|未眠美术馆|SLEEPLESS ART MUSEUM/);
  assert.equal(state.versions[0].review.tang.items.find(item => item.id === 'reservation-qr').state, 'notApplicable');
  await post(`${origin}/api/sessions`, { project: { topic: '社区书市' } });
  const { sessions } = await (await fetch(`${origin}/api/sessions`)).json();
  assert.deepEqual(new Set(sessions.map(item => item.theme.name)), new Set([project.topic, '社区书市']));
  const workbench = await fetch(`${origin}/workbench?project=${state.id}`);
  assert.equal(workbench.status, 200);
  assert.match(await workbench.text(), /id="app"|id="castBreakout"/);

  const fromZhou = state.requirements.filter(item => item.role === 'zhou');
  assert.ok(fromZhou.length >= 2 && fromZhou.every(item => item.versionId === 'V01'));
  const sent = await post(`${origin}/api/sessions/${state.id}/commands`, {
    id: randomUUID(), type: 'assign', payload: { sourceIds: [fromZhou[0].id] }
  });
  assert.equal(sent.status, 200);
  const assigned = (await sent.json()).state.requirements.filter(item => item.role === 'zhou');
  assert.deepEqual(assigned.filter(item => item.status === 'assigned').map(item => item.id), [fromZhou[0].id]);
});

test('设置页保存到 .env，HeyGen :free 配置四个音色并复用一个 API 密钥', async t => {
  const { origin, envFile } = await studioFixture(t);
  const audio = Buffer.alloc(250, 7);
  const calls = [];
  const router = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(audio);
  });
  const upstream = await listener(router);
  t.after(() => new Promise(resolve => router.close(resolve)));
  const voices = { zhou: 'gareth', lin: 'sabrina', tang: 'lucian', yi: 'bram' };
  const secret = 'qa-openrouter-key';
  const tts = { mode: 'openrouter', url: `${upstream}/api/v1/audio/speech`, voices };
  const saved = await post(`${origin}/api/settings`, { tts: { ...tts, key: secret } });
  assert.equal(saved.status, 200);
  const status = await saved.json();
  assert.ok(!JSON.stringify(status).includes(secret));
  assert.equal(status.tts.providers.openrouter.hasKey, true);
  assert.equal(status.asr.available, false);
  assert.deepEqual(status.tts.activeVoices, Object.keys(voices));
  const result = parseEnv(await readFile(envFile, 'utf8'));
  assert.ok(result.OPENROUTER_API_KEY === secret);
  assert.equal(result.KEEP_LOCAL_SETTING, 'same');
  assert.equal(result.OPENROUTER_TTS_MODEL, 'heygen/heygen-voice-1-turbo:free');
  assert.equal((await fetch(`${origin}/.env`)).status, 404);
  for (const [role, voice] of Object.entries(voices)) {
    const response = await post(`${origin}/api/speech`, { role, text: '工作台配音测试。', mood: 'firm' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-voice-provider'), 'openrouter');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
    assert.deepEqual(calls.at(-1).body, { model: 'heygen/heygen-voice-1-turbo:free', input: '工作台配音测试。', voice, response_format: 'mp3' });
    assert.ok(calls.at(-1).authorization === `Bearer ${secret}`);
  }
  await post(`${origin}/api/settings`, { tts: { ...tts, key: '' } });
  assert.ok(parseEnv(await readFile(envFile, 'utf8')).OPENROUTER_API_KEY === secret);
  await post(`${origin}/api/settings`, { tts: { ...tts, clearKey: true } });
  assert.equal((await (await fetch(`${origin}/api/speech`)).json()).synthesis, 'local');
});

test('同一局连续拍桌轮换四条小乙反应，发言事件与拍桌引用同文', async t => {
  const { origin } = await studioFixture(t);
  const { id } = await (await post(`${origin}/api/sessions`, { project: { topic: '拍桌测试' } })).json();
  const seen = [];
  for (let index = 0; index < 5; index++) {
    const response = await post(`${origin}/api/sessions/${id}/commands`, { id: randomUUID(), type: 'nudge', payload: { source: 'desk' } });
    assert.equal(response.status, 200);
    const { events } = await response.json();
    const slap = events.find(event => event.type === 'slap');
    const dialogue = events.find(event => event.type === 'dialogue');
    assert.equal(slap.data.reply, dialogue.data.turns[0].text);
    seen.push(slap.data.reply);
  }
  assert.equal(new Set(seen.slice(0, 4)).size, 4);
  assert.equal(seen[4], seen[0]);
});
