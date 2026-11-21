import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createDialogueModel } from './dialogue-model.mjs';
import { openingLines } from './roles.mjs';
import { activeAgent, settingsDefaults } from './runtime-config.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const project = { topic: '社区市集', brief: '市集免费入场，东门入口。', facts: { venue: '社区广场', gate: '东门入场', admission: '免费' } };
const primary = { id: 'lin-main', stage: 'goal', text: '署名要清楚。', goal: '主办署名可辨', instruction: '把主办方署名放大。', elementIds: ['credits'] };
const line = { role: 'lin', text: '把署名给我留全。', mood: 'point', elementIds: ['credits'], requirement: primary };

test('both review modes use provider token limits and keep the complete speech', async t => {
  const phrase = 'Keep the headline bold and give the illustration more breathing room. ';
  const structuredSpeech = phrase.repeat(5).trim();
  const streamedParts = [phrase.repeat(100), phrase.repeat(100)];
  const streamedSpeech = streamedParts.join('').trim();
  const requestBodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    requestBodies.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: {
      content: JSON.stringify({ role: 'lin', speech: structuredSpeech, requirements: [] }),
    }, finish_reason: 'stop' }] });
    const frames = streamedParts.map(content => JSON.stringify({ choices: [{ index: 0, delta: { content } }] }));
    frames.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), '[DONE]');
    return new Response(frames.map(data => `data: ${data}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });

  const model = createDialogueModel({ mode: 'api', url: 'https://review-fixture.invalid/v1/chat/completions', model: 'quiz' });
  const input = { role: 'lin', language: 'en', version: 'V01', imageDataUrl: png };
  assert.equal((await model.roundTurn(input)).speech, structuredSpeech);
  const chunks = [];
  const meeting = await model.meetingTurn(input, undefined, ({ text }) => chunks.push(text));
  assert.equal(meeting.speech, streamedSpeech);
  assert.equal(chunks.join(' '), streamedSpeech);
  assert.deepEqual(requestBodies.map(body => body.stream === true), [false, true]);
  assert.match(requestBodies[0].messages[0].content, /一到两句短话/);
  assert.match(requestBodies[1].messages[0].content, /one or two short sentences/);
  for (const body of requestBodies) {
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  }
});

async function mockChat(t, callback) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const request = { authorization: req.headers.authorization, path: req.url, data: JSON.parse(Buffer.concat(chunks)) };
    requests.push(request);
    const content = await callback(request);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('视觉评审将真实 PNG 单独发给视觉接口，并校验结构化角色和需求', async t => {
  const { url, requests } = await mockChat(t, () => JSON.stringify({
    role: 'lin', text: '右上角，先给主办方腾出位置。', mood: 'sharp', elementIds: ['logo', 'unknown'], challengeRole: 'tang', memory: '坚持标志留白。', score: 10, patches: [],
    requirements: [
      { role: 'lin', id: 'prototype', text: '馆标要完整', goal: '标志完整', instruction: '把馆标移到左下角。', condition: '右上不挤压。', elementIds: ['unknown', 'logo'] },
      { role: 'zhou', text: '借用老板的权限', elementIds: ['title'] },
      { text: '控制配色', goal: '配色统一', instruction: '把配色换成夜紫。', elementIds: ['palette'] },
      { text: '额外需求', instruction: '缩小宣传语。', elementIds: ['tagline'] },
    ]
  }));
  const model = createDialogueModel({ mode: 'api', url: `${url}/text`, model: 'text-1', key: 'text-fixture' }, { url: `${url}/vision`, model: 'vision-1', key: 'vision-fixture' });
  assert.equal(model.canReviewImage, true);
  const result = await model.roundTurn({
    role: 'lin', phase: 'review', line, project, version: 'V04', imageDataUrl: png,
    context: { memory: [{ versionId: 'V03', text: '上一版先核对署名。' }], history: [{ role: 'manager', text: '请看右上角。' }], changedElements: ['logo', 'invalid'] },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/vision');
  assert.equal(requests[0].authorization, 'Bearer vision-fixture');
  assert.equal(requests[0].data.model, 'vision-1');
  const content = requests[0].data.messages[1].content;
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: png } });
  assert.deepEqual(JSON.parse(content[0].text).context.changedElements, ['logo']);
  assert.equal(JSON.parse(content[0].text).context.memory, '上一版先核对署名。');
  assert.equal(result.role, 'lin');
  assert.equal(result.mode, 'online');
  assert.equal(result.memory, '坚持标志留白。');
  assert.equal(result.challengeRole, 'tang');
  assert.equal(result.score, undefined);
  assert.equal(result.patches, undefined);
  assert.equal(result.requirement, primary);
  assert.deepEqual(result.elementIds, ['logo']);
  assert.equal(result.requirements.length, 3);
  assert.deepEqual(result.requirements[1].elementIds, ['logo']);
  assert.match(result.requirements[1].id, /^lin-[0-9a-f]+$/);
});

test('文本评审与问答沿用同一结构，视觉未启用时不发送图片', async t => {
  const { url, requests } = await mockChat(t, () => [{ type: 'text', text: '```json\n{"role":"lin","text":"署名保持全称。","mood":"angry","elementIds":["credits"],"challengeRole":"lin"}\n```' }]);
  const model = createDialogueModel({ mode: 'api', url, model: 'text-model' });
  assert.equal(model.canReviewImage, false);
  const result = await model.roundTurn({ role: 'lin', phase: 'review', line, project, version: 'V03', imageDataUrl: png });
  assert.equal(result.text, '署名保持全称。');
  assert.equal(result.mood, 'point');
  assert.equal(result.challengeRole, undefined);
  const answer = await model({ question: '署名怎么处理？', line, project, version: 'V03' });
  assert.equal(answer.role, 'lin');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const content = request.data.messages[1].content;
    assert.equal(typeof content, 'string');
    assert.ok(!content.includes(png));
  }
  assert.equal(JSON.parse(requests[1].data.messages[1].content).question, '署名怎么处理？');
  const visionOnly = createDialogueModel({ mode: 'local' }, { url, model: 'vision-model' });
  assert.equal(visionOnly.canAnswerText, false);
  assert.equal((await visionOnly({ question: '问署名', line, project })).mode, 'local');
  assert.equal(createDialogueModel({ mode: 'local' }), null);
});

test('OpenCode Go 预设使用订阅接口，文本与 PNG 评审沿用角色会话编号', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ role: 'lin', text: '把署名放大。' }) } }]
  }));
  const { text, vision } = activeAgent(settingsDefaults({ STUDIO_AGENT_MODE: 'opencode-go', OPENCODE_GO_API_KEY: 'mock-go-key' }));
  const model = createDialogueModel(text, vision);
  const sessionId = crypto.randomUUID();
  await model.roundTurn({ role: 'lin', line, project, sessionId, version: 'V02', imageDataUrl: png });
  await model({ question: '署名放多大？', line, project, sessionId, version: 'V03' });
  for (const call of fetch.mock.calls) {
    const [endpoint, request] = call.arguments;
    assert.equal(endpoint.href, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.equal(request.headers['X-OpenCode-Session'], `ses_${sessionId}_lin`);
    assert.equal(request.headers['User-Agent'], 'yifang-studio/1.0');
    assert.equal(request.headers.Authorization, 'Bearer mock-go-key');
    assert.equal(JSON.parse(request.body).model, 'hy4-flash-free');
  }
});

test('错误事实、错误分数、串角色和无效 JSON 返回失败以使用本地种子', async t => {
  const outputs = [
    { role: 'lin', text: '预约改成收费，走西门入场。' },
    { role: 'lin', text: '这版我给 99 分。' },
    { role: 'tang', text: '主办方字号改大。' },
    '没有 JSON',
  ];
  const { url } = await mockChat(t, () => JSON.stringify(outputs.shift()));
  const model = createDialogueModel({ mode: 'api', url, model: 'fixture' });
  const input = { question: '几点入场？', line, project, context: { review: { lin: { score: 65, delta: -35, items: [] } } } };
  await assert.rejects(model(input), /事实不符/);
  await assert.rejects(model(input), /事实不符/);
  await assert.rejects(model(input), /其他角色/);
  await assert.rejects(model(input), /其他角色|JSON/);
});

test('插话可撤销请求，开场失败仍产生多条本地需求', async t => {
  const { url, requests } = await mockChat(t, async () => { await setTimeout(120); return '坏响应'; });
  const model = createDialogueModel({ mode: 'api', url, model: 'fixture', timeoutMs: 1000 });
  const controller = new AbortController();
  const answer = model({ question: '署名怎么处理？', line, project }, controller.signal);
  const aborted = assert.rejects(answer, { name: 'AbortError' });
  while (!requests.length) await setTimeout(2);
  controller.abort();
  await aborted;
  const opening = await model.openings(openingLines(), project);
  assert.equal(opening[0].text, '高级一点。');
  assert.ok(opening.every(turn => turn.mode === 'local' && turn.requirements.length >= 2));
});
