import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createStudioServer } from '../server.mjs';
import { sha256 } from './storage.mjs';

async function fixture(t, options = {}) {
  const prefix = 'yifang-session-test-';
  const temporary = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(temporary, prefix));
  let studio;
  let port = 0;
  let id;
  t.after(async () => {
    await studio?.close();
    if (path.dirname(dir) === temporary && path.basename(dir).startsWith(prefix)) await rm(dir, { recursive: true });
  });

  async function boot() {
    studio = createStudioServer({ dataDirectory: dir, voiceEnabled: false, settingsEnv: {}, stepMs: 24, ...options });
    await new Promise(resolve => studio.server.listen(port, '127.0.0.1', resolve));
    port = studio.server.address().port;
  }
  const request = (pathname, input, init = {}) => {
    const url = `http://127.0.0.1:${port}${pathname}`;
    const headers = { Connection: 'close', ...init.headers };
    return fetch(url, input === undefined ? { ...init, headers } : {
      ...init, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input)
    });
  };
  await boot();
  const create = await request('/api/sessions', {});
  assert.equal(create.status, 201);
  const initial = await create.json();
  id = initial.id;
  const root = `/api/sessions/${id}`;
  const state = async () => (await request(root)).json();
  async function command(type, payload, commandId = randomUUID(), expected = 200) {
    const response = await request(`${root}/commands`, { id: commandId, type, payload });
    const data = await response.json();
    assert.equal(response.status, expected, data.error);
    return data;
  }
  return {
    initial, state, command, request, root,
    async restart() {
      await studio.close();
      studio = null;
      await boot();
    }
  };
}

async function until(state, predicate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await state();
    if (predicate(value)) return value;
    await sleep(25);
  }
  assert.fail('会话未在规定时间到达预期状态');
}

const scores = state => Object.values(state.versions.at(-1).review).map(review => review.score);

test('黄贴分歧可交付，工单刷新、重启与重复催促只提交一次', async t => {
  const app = await fixture(t);
  const { initial, state, command, root, request } = app;
  assert.deepEqual(scores(initial), [100, 100, 85]);
  assert.equal((await request('/reservation')).status, 200);
  const vague = initial.messages.find(line => line.role === 'zhou');
  const clarification = await command('assign', { sourceIds: [vague.id] });
  assert.equal(clarification.result.clarification, true);
  assert.equal(clarification.state.job, null);
  const answer = await command('ask', { role: 'zhou', text: '高级指哪里？' });
  assert.equal(answer.state.messages.at(-1).requirement.stage, 'goal');
  assert.ok(answer.state.messages.at(-1).elementIds.includes('title'));

  const job = await command('assign', { text: '把免费须预约做成标题旁的大黄贴，盖住半个馆标' });
  assert.equal(job.state.job.id, 'J01');
  const paused = await until(state, data => data.job?.status === 'paused');
  assert.equal(paused.job.progress, 50);
  const initialExport = await command('export', { versionId: 'V01', format: 'svg' });
  assert.equal(initialExport.result.versionId, 'V01');
  await app.restart();
  assert.equal((await state()).job.status, 'paused');

  const id = randomUUID();
  const resumed = await command('nudge', { source: 'keyboard' }, id);
  const duplicate = await command('nudge', { source: 'keyboard' }, id);
  assert.equal(resumed.result.resumed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.slaps, 1);
  assert.equal((await command('nudge', { source: 'voice', text: '快点，继续刚才那张' })).result.resumed, false);
  const reviewed = await until(state, data => data.versions.length === 2);
  assert.equal(reviewed.job.status, 'completed');
  assert.deepEqual(scores(reviewed), [80, 65, 100]);
  const second = reviewed.versions.at(-1);
  assert.deepEqual(second.diff.map(item => item.id), ['sticker']);
  assert.deepEqual(Object.values(second.review).map(review => review.delta), [-20, -35, 15]);
  assert.ok(reviewed.lastDialogue.some(line => line.replyTo));
  assert.ok(second.issues.some(issue => issue.status === 'open'));
  assert.ok(initial.requirements.every(need => reviewed.requirements.some(item => item.id === need.id && item.versionId === 'V01')));
  assert.ok(reviewed.requirements.some(need => need.versionId === 'V02'));

  const exported = await command('export', { versionId: 'V02', format: 'png' });
  const file = await request(exported.result.url);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const content = Buffer.from(await file.arrayBuffer());
  assert.equal(sha256(content), second.pngHash);
  assert.equal(content.readUInt32BE(16), 600);
  assert.equal(content.readUInt32BE(20), 800);
  await command('finalize', { versionId: 'V02' });

  await command('assign', { text: '把黄贴移到预约码旁边，别动馆标' });
  const consolidated = await until(state, data => data.versions.length === 3);
  assert.deepEqual(scores(consolidated), [100, 100, 100]);
  assert.deepEqual(consolidated.versions.at(-1).diff.map(item => item.id), ['sticker']);
  const old = await command('selectVersion', { versionId: 'V02' });
  assert.equal(old.state.selectedVersionId, 'V02');
  assert.equal((await command('export', { versionId: 'V02', format: 'svg' })).result.hash, second.hash);
  const restored = await command('restore', { versionId: 'V01' });
  assert.equal(restored.state.versions.at(-1).restoredFromId, 'V01');
  assert.deepEqual(scores(restored.state), [100, 100, 85]);
  assert.equal(restored.state.finalizedVersionId, 'V02');

  const response = await request(`${root}/events`, undefined, { headers: { 'Last-Event-ID': String(paused.seq) } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  let body = '';
  while (!/\ndata: [^\n]*\n\n/.test(body)) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    body += new TextDecoder().decode(value);
  }
  const update = JSON.parse(body.match(/\ndata: ([^\n]*)\n\n/)[1]);
  assert.ok(update.events.some(event => event.type === 'job-resumed'));
  assert.ok(!update.events.some(event => event.type === 'job-paused'));
  await reader.cancel();
});

test('封存回放绑定业务序号、播放位置及可校验资源，呈现轨迹去重', async t => {
  const { initial, root, request, command } = await fixture(t);
  const next = await command('export', { versionId: 'V01', format: 'svg' });
  const at = Date.now();
  const audio = Buffer.from('stored rehearsal audio');
  const hash = sha256(audio);
  const meta = { kind: 'voice', messageId: 'M1', role: 'zhou' };
  const asset = await request(`${root}/media`, { mime: 'audio/mpeg', data: audio.toString('base64'), hash, at, observedSeq: initial.seq, meta });
  assert.equal(asset.status, 200);
  const entries = [
    { type: 'audio-start', data: { ...meta, hash, offsetMs: 0 } },
    { type: 'audio-stop', data: { ...meta, hash, offsetMs: 800, reason: 'interrupt' } },
    { type: 'ui.draft', data: { value: '挪开黄贴' } }
  ].map((entry, index) => ({ ...entry, pageId: 'page-test', clientSeq: index + 1, observedSeq: initial.seq, at: at + index }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(`${root}/presentation`, { records: entries });
    assert.equal((await response.json()).received.length, 3);
  }
  const snapshot = await (await request(`${root}/replay?until=${initial.seq}`)).json();
  assert.equal(snapshot.untilSeq, initial.seq);
  assert.equal(snapshot.presentation.length, 3);
  assert.equal(snapshot.presentation[1].data.offsetMs, 800);
  assert.equal(snapshot.assets[hash].hash, hash);
  assert.deepEqual(snapshot.missing, []);
  assert.ok(snapshot.snapshots.length >= 1);
  assert.ok(snapshot.events.every(event => event.seq < next.events[0].seq));
  const range = await request(`/api/media/${hash}`, undefined, { headers: { Range: 'bytes=0-5' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'stored');
});

test('经理提问按顺序排队，旧打断命令被拒绝，完成的旧版答复归到原版本', async t => {
  const started = [];
  let aborted = false;
  let finishFirst;
  const waitForFirst = new Promise(resolve => { finishFirst = resolve; });
  t.after(finishFirst);
  const dialogueModel = async ({ line, question }, signal) => {
    started.push(question);
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    if (started.length === 1) await waitForFirst;
    return { ...line, text: `已答「${question}」`, mode: 'online' };
  };
  const { state, command, root, request } = await fixture(t, { dialogueModel });
  const first = await command('ask', { role: 'zhou', text: '标题优先吗？' });
  await until(state, snapshot => snapshot.awaitingRole === 'zhou' && started.length === 1);
  const second = await command('ask', { role: 'lin', text: '标志要多大？' });
  assert.deepEqual(started, ['标题优先吗？']);
  await command('interrupt', { source: 'mic' }, randomUUID(), 400);
  const newer = await command('restore', { versionId: 'V01' });
  assert.equal(newer.state.selectedVersionId, 'V02');
  assert.equal(newer.state.awaitingRole, 'zhou');

  finishFirst();
  const current = await until(state, snapshot => snapshot.messages.filter(message => message.kind === 'answer').length === 2);
  const answers = current.messages.filter(message => message.kind === 'answer');
  assert.deepEqual(started, ['标题优先吗？', '标志要多大？']);
  assert.deepEqual(answers.map(message => message.text), ['已答「标题优先吗？」', '已答「标志要多大？」']);
  assert.deepEqual(answers.map(message => message.replyTo), [first, second].map(result => result.state.messages.findLast(message => message.kind === 'question').id));
  assert.ok(answers.every(message => message.versionId === 'V01'));
  assert.equal(current.selectedVersionId, 'V02');
  assert.equal(current.awaitingRole, null);
  assert.equal(aborted, false);
  const replay = await (await request(`${root}/replay`)).json();
  const completed = replay.events.filter(event => event.type === 'dialogue' && event.data.turns.some(message => message.kind === 'answer'));
  assert.equal(completed.length, 2);
  assert.ok(completed.every(event => event.versionId === 'V01' && event.data.auto === false));
});

test('关闭服务取消在途请求，恢复后的问答只记一次，迟到旧结果不覆写', async t => {
  let attempts = 0;
  let aborted = false;
  let releaseOld;
  const oldResult = new Promise(resolve => { releaseOld = resolve; });
  const dialogueModel = async ({ line }, signal) => {
    if (++attempts === 1) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await oldResult;
      return { ...line, text: '重启前迟到的台词', mode: 'online' };
    }
    return { ...line, text: '恢复后确认的台词', mode: 'online' };
  };
  const app = await fixture(t, { dialogueModel });
  try {
    await app.command('ask', { role: 'zhou', text: '标题放在哪？' });
    await until(app.state, snapshot => snapshot.awaitingRole === 'zhou' && attempts === 1);
    await app.restart();
    await until(app.state, snapshot => snapshot.messages.some(message => message.text === '恢复后确认的台词'));
    releaseOld();
    await sleep(35);
    const recovered = await app.state();
    assert.equal(aborted, true);
    assert.equal(attempts, 2);
    assert.deepEqual(recovered.messages.filter(message => message.kind === 'answer').map(message => message.text), ['恢复后确认的台词']);
  } finally {
    releaseOld();
  }
});

test('真实 PNG 按每角色每版本一次发送，三方评审引用上句、有多条需求并跨版记忆', async t => {
  const captures = [];
  const nextRole = { zhou: 'lin', lin: 'tang', tang: 'zhou' };
  const voices = {
    zhou: ['展名得先被看到。', 'firm', 'title', '把展名放大一点。'],
    lin: ['看右上，馆标要有净空。', 'sharp', 'logo', '把馆标移到左下角。'],
    tang: ['预约条件靠近入口，观众找得快。', 'urgent', 'sticker', '把黄贴移到预约码旁边。'],
  };
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages[1].content;
    const input = JSON.parse(Array.isArray(content) ? content[0].text : content);
    const image = Array.isArray(content) ? content[1] : null;
    captures.push({ path: req.url, input, image, model: body.model });
    const [text, mood, element, instruction] = voices[input.role];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      role: input.role, text, mood, elementIds: [element], challengeRole: nextRole[input.role], memory: `${input.version} ${input.role} 的首要标准是${element}。`,
      requirements: [
        { text: '先检查目标图层', goal: '目标图层在手机可读', instruction, elementIds: [element], stage: 'criterion' },
        { text: '压低宣传语', goal: '宣传语处于次要层级', instruction: '把宣传语缩小一点。', elementIds: ['tagline'], stage: 'criterion' },
      ],
    }) } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const host = `http://127.0.0.1:${upstream.address().port}`;
  const { state, command } = await fixture(t, { settingsEnv: {
    STUDIO_AGENT_MODE: 'api', STUDIO_MODEL_URL: `${host}/text`, STUDIO_MODEL: 'text-fixture',
    STUDIO_VISION_MODE: 'api', STUDIO_VISION_URL: `${host}/vision`, STUDIO_VISION_MODEL: 'vision-fixture',
  } });

  await until(state, snapshot => snapshot.reviewRounds.some(round => round.versionId === 'V01' && round.status === 'completed'));
  await command('assign', { text: '把免费 · 须预约做成标题旁的大黄贴。' });
  await until(state, snapshot => snapshot.job?.status === 'paused');
  await command('nudge', { source: 'button' });
  const complete = await until(state, snapshot => snapshot.reviewRounds.some(round => round.versionId === 'V02' && round.status === 'completed'));

  const secondRound = complete.reviewRounds.find(round => round.versionId === 'V02');
  assert.equal(secondRound.turnCount, 5);
  assert.equal(secondRound.rebuttals, 2);
  assert.deepEqual(secondRound.pngReaders.slice().sort(), ['lin', 'tang', 'zhou']);
  const turns = complete.messages.filter(message => message.roundId === secondRound.id);
  assert.deepEqual(turns.map(message => message.role), ['lin', 'tang', 'zhou', 'lin', 'tang']);
  assert.deepEqual(turns.map(message => message.replyTo), [null, ...turns.slice(0, -1).map(message => message.id)]);
  assert.ok(turns.every(message => message.requirements.length >= 2 && message.requirements.length <= 3));
  assert.deepEqual(scores(complete), [80, 65, 100]);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const version of complete.versions) {
    const seen = new Set();
    const roundCalls = captures.filter(capture => capture.input.version === version.id);
    for (const { input, image, path, model } of roundCalls) {
      if (seen.has(input.role)) {
        assert.equal(path, '/text');
        assert.equal(model, 'text-fixture');
        assert.equal(image, null);
      } else {
        assert.equal(path, '/vision');
        assert.equal(model, 'vision-fixture');
        assert.equal(image.type, 'image_url');
        assert.match(image.image_url.url, /^data:image\/png;base64,/);
        const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        assert.ok(bytes.subarray(0, 8).equals(signature));
        assert.equal(sha256(bytes), version.pngHash);
        assert.notEqual(sha256(bytes), version.hash);
        if (version.id === 'V02') assert.ok(input.context.memory.includes(`V01 ${input.role} 的首要标准`));
        seen.add(input.role);
      }
      assert.doesNotMatch(JSON.stringify(input), /<svg|data:image\/svg\+xml/i);
    }
    assert.deepEqual([...seen].sort(), ['lin', 'tang', 'zhou']);
  }
  const nextCalls = captures.filter(capture => capture.input.version === 'V02');
  assert.deepEqual(nextCalls.map(capture => capture.input.quote?.id ?? null), [null, ...turns.slice(0, -1).map(message => message.id)]);
});

test('预约入口恢复后可为原版补齐证据，海报哈希不变', async t => {
  let online = false;
  const reservation = createServer((req, res) => {
    if (!online || req.url !== '/reservation') {
      res.writeHead(503);
      return res.end();
    }
    res.end('<meta name="studio-reservation" content="museum-night">');
  });
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => reservation.close(resolve)));
  const publicURL = `http://127.0.0.1:${reservation.address().port}`;
  const { initial, command } = await fixture(t, { publicURL });
  assert.equal(initial.versions[0].review.tang.pendingWeight, 25);
  online = true;
  const { state, result } = await command('verifyReservation', { versionId: 'V01' });
  assert.equal(result.qr, 'verified');
  assert.equal(state.versions[0].review.tang.score, 85);
  assert.equal(state.versions[0].hash, initial.versions[0].hash);
});
