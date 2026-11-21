import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDialogueModel, meetingPassMarker } from './dialogue-model.mjs';
import { clientRoles, contextFor, makeReviewRound, nextRoundSlot, pendingMeetingAssignment, readyMeetingAssignment, recordRoundTurn, roundSnapshot } from './review-rounds.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const project = { topic: 'Poster Clinic', brief: 'An event about print design.', facts: { venue: 'Studio Five' } };
const version = { id: 'V03', pngHash: 'a'.repeat(64), review: { zhou: { score: 4 } } };
const completion = { notice: 'V03 is ready for review.', designerSpeech: 'I separated the date and adjusted the title.' };

function streamSpeech(parts) {
  const frames = parts.map(content => JSON.stringify({ choices: [{ index: 0, delta: { content } }] }));
  frames.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), '[DONE]');
  return new Response(frames.map(frame => `data: ${frame}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

function round() {
  return makeReviewRound(version.id, 'review', clientRoles.map(role => ({ role })), null, roundSnapshot(version, project, completion));
}

test('meeting requests share the version handoff, PNG and ordered transcript, with separate system personas', async t => {
  const requests = [];
  const speech = ['Move the date directly below the headline.', 'That would crowd the headline. Put the date by the entrance details.', 'Make the entrance line brighter.'];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push({ body: JSON.parse(request.body), session: request.headers['X-OpenCode-Session'] });
    return streamSpeech([speech[requests.length - 1]]);
  });
  const model = createDialogueModel({ mode: 'api', url: 'https://opencode.ai/inference/go/openai/v1/chat/completions', model: 'fixture' });
  const active = round();
  const state = { language: 'en', messages: [], reviewRounds: [active], versions: [version], requirements: [
    { role: 'zhou', text: 'private requirement' }, { role: 'lin', text: 'other private requirement' },
  ], agentMemory: { zhou: [{ text: 'private memory' }] } };
  const manager = 'Please keep the existing headline.\n' + 'Full manager remark. '.repeat(65).trim();
  const inputs = [];
  for (const [index, role] of clientRoles.entries()) {
    const context = contextFor(state, role, version, active);
    const slot = nextRoundSlot(active);
    assert.equal(slot.role, role);
    assert.deepEqual(Object.keys(context), ['language', 'meeting']);
    const line = await model.meetingTurn({ role, version, context: { ...context, memory: 'private memory', requirements: state.requirements },
      project: { ...project, facts: { ...project.facts, hiddenCondition: 'internal note' } },
      question: 'private question', phase: 'opening', replyTo: { text: 'private quote' }, imageDataUrl: png, sessionId: 'test-project' });
    assert.equal(line.speech, speech[index]);
    inputs.push(context.meeting.turns.map(turn => ({ id: turn.id, role: turn.role, speech: turn.text })));
    const message = { id: `M${index + 1}`, roundId: active.id, role, text: line.speech };
    state.messages.push(message);
    recordRoundTurn(active, message, slot, null, { meeting: true });
    if (index === 0) state.messages.push({ id: 'M-manager', roundId: active.id, role: 'manager', kind: 'meeting-interjection', text: manager });
  }

  assert.deepEqual(inputs.map(turns => turns.map(turn => turn.role)), [[], ['zhou', 'manager'], ['zhou', 'manager', 'lin']]);
  const parsed = requests.map(({ body, session }, index) => {
    assert.equal(session, `ses_test-project_${active.id}`);
    assert.equal(body.stream, true);
    const [system, user] = body.messages;
    assert.equal(system.role, 'system');
    assert.equal(user.role, 'user');
    assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: png } });
    assert.deepEqual(JSON.parse(user.content[0].text), {
      version: version.id, project, context: { meeting: { roundId: active.id, completion, turns: inputs[index] } },
    });
    const [persona, ...shared] = system.content.split('\n');
    return { persona, shared };
  });
  assert.equal(new Set(parsed.map(({ persona }) => persona)).size, 3);
  assert.deepEqual(parsed[0].shared, parsed[1].shared);
  assert.deepEqual(parsed[1].shared, parsed[2].shared);
  assert.equal(active.status, 'completed');
  assert.equal(active.turnCount, 3);
});

test('only an opening address to an earlier different client can route a live rebuttal', async t => {
  const cases = [
    { speech: 'Lin, moving the event date below the logo would hide it from a passerby.', target: 'lin' },
    { speech: '林尺，标题旁的安排会挤掉日期，请换个位置。', target: 'lin' },
    { speech: 'Increase the date a little. Lin, the headline currently looks balanced.' },
    { speech: 'Lin: The data should be in the footer.' },
    { speech: 'Zhou, the date needs more contrast.' },
    { speech: 'Tang, the footer is already legible.' },
  ];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => streamSpeech([cases[call++].speech]));
  const model = createDialogueModel({ mode: 'api', url: 'https://fixture.invalid/chat/completions', model: 'fixture' });
  const turns = [{ id: 'M1', role: 'lin', text: 'Move the date down.' }, { id: 'M2', role: 'tang', text: 'The footer looks light.' }];
  for (const { speech, target } of cases) {
    const chunks = [];
    const result = await model.meetingTurn({ role: 'tang', imageDataUrl: png, context: { meeting: { turns } } },
      undefined, chunk => chunks.push(chunk));
    assert.equal(result.challengeRole, target);
    assert.equal(result.replyTo, target ? 'M1' : undefined);
    assert.equal(result.speech, speech);
    assert.equal(chunks.map(chunk => chunk.text).join(' '), speech);
    assert.ok(chunks.every(chunk => Object.keys(chunk).length === 2));
  }
});

test('meeting silence split across SSE deltas stays out of speech and client traces', async t => {
  const responses = [[' \n[', '[P', 'AS', 'S]', '] '], ['Raise the title. ', '[', '[PASS', ']]']];
  t.mock.method(globalThis, 'fetch', async () => streamSpeech(responses.shift()));
  const model = createDialogueModel({ mode: 'api', url: 'https://fixture.invalid/chat/completions', model: 'fixture' });
  const chunks = [];
  const traces = [];
  const input = { role: 'tang', imageDataUrl: png, onTrace: entry => traces.push(entry) };
  const passed = await model.meetingTurn(input, undefined, chunk => chunks.push(chunk));
  assert.equal(passed.skipped, true);
  assert.equal(passed.done, true);
  assert.equal(passed.text, '');
  assert.deepEqual(chunks, []);
  assert.equal(traces[0].output.skipped, true);
  assert.equal(traces[0].output.message.content, '');
  assert.equal(JSON.stringify(traces[0]).includes(meetingPassMarker), false);

  await assert.rejects(model.meetingTurn(input, undefined, chunk => chunks.push(chunk)), /可朗读的纯文本/);
  assert.ok(chunks.every(chunk => !chunk.text.includes('[')));
});

test('a meeting gives all three clients a first opportunity and opens no work from silence alone', () => {
  const active = round();
  for (const role of clientRoles) {
    const slot = nextRoundSlot(active);
    assert.equal(slot.role, role);
    recordRoundTurn(active, null, slot, null, { meeting: true, skipped: true });
  }
  assert.equal(active.status, 'completed');
  assert.equal(active.turnCount, 3);
  assert.equal(active.assignmentPending, false);
  assert.deepEqual(active.messageIds, []);
  assert.deepEqual(active.rolesSpoken, []);
  assert.equal(nextRoundSlot(active), null);

  const withManager = round();
  withManager.managerRequestedAssignment = true;
  for (const role of clientRoles) {
    const slot = nextRoundSlot(withManager);
    assert.equal(slot.role, role);
    recordRoundTurn(withManager, null, slot, null, { meeting: true, skipped: true });
  }
  assert.equal(withManager.assignmentPending, false);
});

test('legacy closing markers and manager-only lines cannot create an assignment', () => {
  const active = round();
  Object.assign(active, { status: 'completed', autoAssign: false, assignmentPending: true, managerRequestedAssignment: true,
    messageIds: ['M1', 'M2', 'M3'] });
  const state = { versions: [version], reviewRounds: [active], messages: [
    { id: 'M1', role: 'zhou', text: '我这轮就这些。' },
    { id: 'M2', role: 'lin', text: "That's all from me for this round." },
    { id: 'M3', role: 'tang', text: meetingPassMarker },
    { id: 'M4', role: 'manager', roundId: active.id, kind: 'meeting-interjection', text: 'Keep the date.' },
  ] };
  assert.equal(pendingMeetingAssignment(state), null);
  assert.equal(readyMeetingAssignment(state), null);

  active.messageIds.push('M5');
  state.messages.push({ id: 'M5', role: 'zhou', text: 'Give the date more room. 我这轮就这些。' });
  assert.deepEqual(pendingMeetingAssignment(state).feedback.map(turn => [turn.id, turn.text]),
    [['M5', 'Give the date more room. 我这轮就这些。']]);
  assert.equal(readyMeetingAssignment(state), active);
});

test('named rebuttals wait for the first three clients, route only once per person and stop after five turns', () => {
  function speak(active, role, target) {
    const slot = nextRoundSlot(active);
    assert.equal(slot.role, role);
    recordRoundTurn(active, { id: `M${active.turnCount + 1}`, role }, slot, target, { meeting: true });
  }
  const unchanged = round();
  speak(unchanged, 'zhou', 'lin');
  speak(unchanged, 'lin');
  speak(unchanged, 'tang');
  assert.equal(unchanged.turnCount, 3);
  assert.equal(unchanged.status, 'completed');
  assert.equal(unchanged.assignmentPending, true);

  const continued = round();
  speak(continued, 'zhou');
  speak(continued, 'lin', 'zhou');
  speak(continued, 'tang', 'lin');
  assert.deepEqual(nextRoundSlot(continued), { role: 'zhou', replyTo: 'M2', rebuttal: true });
  speak(continued, 'zhou', 'lin');
  assert.deepEqual(nextRoundSlot(continued), { role: 'lin', replyTo: 'M4', rebuttal: true });
  speak(continued, 'lin', 'tang');
  assert.equal(continued.turnCount, 5);
  assert.equal(continued.rebuttals, 2);
  assert.equal(continued.status, 'completed');
  assert.equal(nextRoundSlot(continued), null);
});

test('legacy meetings keep the existing handoff and continue from the first unasked role', () => {
  const legacy = makeReviewRound(version.id, 'review', clientRoles.map(role => ({ role })), null, roundSnapshot(version, project));
  const published = { ...version, jobId: 'J03' };
  const state = { language: 'zh-CN', versions: [published], reviewRounds: [legacy], messages: [
    { id: 'M1', role: 'yi', kind: 'job', versionId: version.id, speech: '稿件已调整标题。' },
    { id: 'M2', role: 'zhou', roundId: legacy.id, text: '建议再留一些标题空间。' },
  ] };
  Object.assign(legacy, { status: 'running', turnCount: 1, messageIds: ['M2'], rolesSpoken: ['zhou'], unsaid: ['lin', 'tang'] });
  const before = contextFor(state, 'lin', published, legacy);
  assert.deepEqual(before, contextFor(state, 'tang', published, legacy));
  assert.equal(before.meeting.completion.designerSpeech, '稿件已调整标题。');
  assert.equal(before.meeting.turns[0].id, 'M2');
  for (const role of ['lin', 'tang']) {
    const slot = nextRoundSlot(legacy);
    assert.equal(slot.role, role);
    recordRoundTurn(legacy, null, slot, null, { meeting: true, skipped: true });
  }
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.turnCount, 3);
});
