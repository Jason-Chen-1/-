import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createDesignerModel } from './designer-model.mjs';
import { createInitialPoster } from './initial-poster.mjs';
import { applyPatch, getElement } from './poster.mjs';
import * as poster from './poster-render.mjs';
import { projectTheme } from './project-theme.mjs';
import { createSessions, publicState } from './sessions.mjs';
import { openStore } from './storage.mjs';

const project = projectTheme(undefined, { topic: 'Open Studio', brief: 'An evening exhibition', venue: 'North Hall' });
const text = 'Move the title and keep the venue in place.';
const early = { id: 'guide-1', kind: 'text', text: 'Keep the heading at the upper left.' };
const late = { id: 'guide-2', kind: 'voice', text: 'Add slightly more space before the heading.' };
const firstProgress = 'I’m checking the title against the layout.';
const secondProgress = 'I’m making the last spacing adjustment.';
const delivered = 'The heading now has more breathing room.';

function draftInput(options = {}) {
  return { scene: createInitialPoster(project), text, project, language: 'en', versionId: 'V01', ...options };
}

function designer() {
  return createDesignerModel({ mode: 'api', url: 'https://designer.fixture.invalid/v1/chat/completions', model: 'designer-fixture' });
}

function preview(scene) {
  const raster = poster.rasterizePoster(poster.posterSVG(scene));
  const bytes = raster.asPng();
  return { imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    imageHash: createHash('sha256').update(bytes).digest('hex'), width: raster.width, height: raster.height };
}

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const move = (id, x) => tool(id, 'run_canvas', { commands: [{ op: 'arrange', operations: [{ op: 'set', id: 'title', set: { x, w: 430 } }] }] });
const submit = (id, speech) => tool(id, 'submit_draft', { speech });

function response(content, ...calls) {
  return Response.json({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
    role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}),
  } }] });
}

function messageText(message) {
  return typeof message.content === 'string' ? message.content : (message.content ?? [])
    .filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function messageIndex(messages, text) {
  return messages.findIndex(message => message.role === 'user' && messageText(message).includes(text));
}

test('Pi keeps Xiao Yi’s own history and inserts signed-off guidance after complete tool results', async t => {
  const requests = [];
  const guidance = [];
  const spoken = [];
  const failures = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    switch (requests.length) {
      case 1: return response(firstProgress, move('move-first', 100), tool('inspect-first', 'inspect_poster', {}));
      case 2: return response('Checking now. <svg><desc>RAW-SVG</desc></svg>', move('move-second', 120));
      case 3:
        guidance.push(late);
        return response('The draft is ready.', submit('submit-first', 'I have delivered the earlier arrangement.'));
      case 4: return response(secondProgress, move('move-final', 140));
      case 5: return response('This poster is now ready.', submit('submit-final', delivered));
      default:
        failures.push(`Unexpected Pi turn after ${requests.length - 1} fixture replies`);
        assert.fail(failures.at(-1));
    }
  });
  const result = await designer()(draftInput({
    history: [
      { role: 'yi', instruction: 'Move the sponsor mark away from the date.', reply: 'I moved the sponsor mark.' },
      { role: 'zhou', instruction: 'PRIVATE-PREVIOUS-CLIENT', reply: 'This was not Xiao Yi’s reply.' },
    ],
    context: {
      sourceMessages: [{ id: 'M12', role: 'lin', text: 'PRIVATE-UNFORWARDED-COMMENT',
        requirements: [{ id: 'r1', instruction: 'Keep the venue legible.', memory: 'PRIVATE-CLIENT-MEMORY' }] }],
      meeting: { roundId: 'R01', versionId: 'V01', turns: [{ text: 'PRIVATE-MEETING-TURN' }] },
      nudges: [{ text: 'PRIVATE-PREVIOUS-DESK-CHAT' }],
      previousError: { code: 'render-error', message: 'Repair an out-of-bounds layer before delivery.', trace: 'PRIVATE-TRACE' },
    },
  }), {
    // The same server batch may be read more than once. Stable IDs ensure only one model input.
    takeGuidance: async () => [...guidance],
    onSpeech: async line => { spoken.push(line); },
    onTrace: trace => { if (trace.status === 'error') failures.push(`${trace.tool}: ${trace.output?.error}`); },
    validateDraft(scene) {
      if (getElement(scene, 'title').x === 100 && !guidance.length) {
        assert.deepEqual(spoken, [{ index: 0, text: firstProgress }], 'speak before the first drawing tool runs');
        guidance.push(early);
      }
      return preview(scene);
    },
  }).catch(error => assert.fail([error.message, ...failures].join('\n')));
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 5);
  const first = requests[0].messages;
  assert.equal(first[0].role, 'system');
  assert.match(first[0].content, /You are Xiao Yi/);
  assert.deepEqual(first.slice(1, 3).map(({ role, content }) => [role, content]), [
    ['user', 'Move the sponsor mark away from the date.'], ['assistant', 'I moved the sponsor mark.'],
  ]);
  assert.ok(messageIndex(first, 'Keep the venue legible.') > 2);
  assert.deepEqual(JSON.parse(first.at(-1).content[0].text).context.previousError,
    { code: 'render-error', message: 'Repair an out-of-bounds layer before delivery.' });
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE-/);
  const afterBatch = requests[1].messages;
  const endOfBatch = afterBatch.findIndex(message => message.tool_call_id === 'inspect-first');
  assert.ok(endOfBatch > 0);
  assert.equal(afterBatch[endOfBatch - 1].tool_call_id, 'move-first');
  assert.equal(messageIndex(afterBatch, early.text), endOfBatch + 1);
  assert.equal(requests[2].messages.filter(message => messageText(message).includes(early.text)).length, 1);
  const afterCandidate = requests[3].messages;
  assert.equal(messageIndex(afterCandidate, late.text), afterCandidate.findIndex(message => message.tool_call_id === 'submit-first') + 1);
  assert.deepEqual(spoken, [{ index: 0, text: firstProgress }, { index: 1, text: secondProgress }]);
  assert.equal(result.reply, delivered);
  assert.deepEqual(result.memory.guidance, [early, late]);
  assert.match(result.memory.instruction, /Keep the venue legible/);
  assert.equal(result.patches.at(-1).set.x, 140);
});

test('session planning keeps one designer active, coalesces desk taps and remembers delivered guidance', { timeout: 15_000 }, async t => {
  const temporary = path.resolve(tmpdir());
  const prefix = 'studio-designer-guidance-';
  const dir = mkdtempSync(path.join(temporary, prefix));
  const store = openStore(dir);
  const releaseFirstTool = Promise.withResolvers();
  const releaseSecondTool = Promise.withResolvers();
  const timeline = [];
  const designs = [];
  let first;
  t.mock.method(Math, 'random', () => .5);
  const sessions = createSessions(store, {
    poster, stepMs: 0,
    publish({ events }) { for (const event of events) timeline.push({ event }); },
    onDesignerSpeech(chunk) { timeline.push({ chunk }); },
    getDialogueModel: () => ({ async meetingTurn({ role }) {
      return { role, mode: 'online', skipped: true, done: true, text: '', speech: '' };
    } }),
    getDesignerModel: () => async (task, { signal, validateDraft, takeGuidance, onSpeech }) => {
      designs.push({ task, signal });
      const guidance = [];
      if (task.initial) {
        await releaseFirstTool.promise;
        signal.throwIfAborted();
        guidance.push(...await takeGuidance());
        await onSpeech({ text: firstProgress, index: 0 });
        first = [...guidance];
        await releaseSecondTool.promise;
        signal.throwIfAborted();
        guidance.push(...await takeGuidance());
        await onSpeech({ text: secondProgress, index: 1 });
      }
      const patches = [{ op: 'set', id: 'title', set: { x: task.initial ? 58 : 72, w: 430 } }];
      await validateDraft(applyPatch(task.scene, patches).scene);
      const reply = task.initial ? delivered : 'I aligned the new revision.';
      return { patches, elementIds: ['title'], label: 'Title fit', reply,
        memory: { instruction: task.text, reply, guidance, at: Date.now() } };
    },
  });
  t.after(() => {
    sessions.close();
    releaseFirstTool.resolve();
    releaseSecondTool.resolve();
    store.close();
    if (path.dirname(dir) === temporary && path.basename(dir).startsWith(prefix)) rmSync(dir, { recursive: true });
  });

  const created = await sessions.newSession(project, 'https://example.invalid/reservation', false, 'en');
  const state = () => store.require(created.id);
  const command = (type, payload) => {
    const result = sessions.command(created.id, { id: crypto.randomUUID(), type, payload });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const current = state();
      if (predicate(current)) return current;
      assert.notEqual(current.job?.status, 'failed', current.job?.error);
      await delay(15);
    }
    assert.fail('The studio did not reach the expected checkpoint');
  }
  const deskTap = () => command('nudge', { source: 'button' });
  await waitFor(() => designs.length === 1);
  const ticket = state().job.planClaim.ticket;
  const firstSignal = designs[0].signal;
  assert.deepEqual(designs[0].task.history, []);
  assert.equal(deskTap().result.queued, true);
  assert.equal(deskTap().result.alreadyQueued, true);
  const voices = [early.text, late.text].map(text => ({ text,
    id: command('meetingInterject', { source: 'voice', text }).result.messageId,
  }));
  deskTap();
  assert.equal(firstSignal.aborted, false);
  assert.equal(state().job.planClaim.ticket, ticket);
  assert.equal(designs.length, 1);

  releaseFirstTool.resolve();
  await waitFor(() => first !== undefined);
  assert.equal(first.filter(item => item.kind === 'rush').length, 1);
  assert.deepEqual(first.filter(item => item.kind !== 'rush').map(({ id, text }) => ({ id, text })), voices);
  const live = timeline.find(item => item.chunk)?.chunk;
  assert.deepEqual([live?.turnId, live?.jobId, live?.index, live?.text], [ticket, created.job.id, 0, firstProgress]);
  assert.equal(state().messages.some(message => message.kind === 'designer-progress'), false);

  assert.equal(deskTap().result.queued, true);
  assert.equal(deskTap().result.alreadyQueued, true);
  assert.equal(firstSignal.aborted, false);
  assert.equal(state().job.planClaim.ticket, ticket);
  releaseSecondTool.resolve();
  const completed = await waitFor(current => current.job?.status === 'awaitingApproval');
  assert.equal(completed.job.id, created.job.id);
  assert.equal(designs.length, 1);
  const [past] = completed.designerMemory;
  assert.equal(past.reply, delivered);
  assert.equal(past.instruction, designs[0].task.text);
  assert.deepEqual(past.guidance.slice(0, first.length), first);
  const second = past.guidance.slice(first.length);
  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'rush');
  assert.notEqual(second[0].id, first.find(item => item.kind === 'rush').id);
  assert.deepEqual(completed.designerGuidance, []);

  const chunks = timeline.flatMap(item => item.chunk ? [item.chunk] : []);
  assert.deepEqual(chunks.map(({ index, text, turnId }) => [index, text, turnId]), [[0, firstProgress, ticket], [1, secondProgress, ticket]]);
  const progressIndex = timeline.findIndex(item => item.event?.data?.message?.kind === 'designer-progress');
  assert.ok(progressIndex > timeline.findLastIndex(item => item.chunk));
  const progress = timeline[progressIndex].event.data.message;
  assert.equal(progress.turnId, ticket);
  assert.equal(progress.speech, `${firstProgress} ${secondProgress}`);
  const publicCompleted = publicState(completed);
  assert.equal(Object.hasOwn(publicCompleted, 'designerMemory'), false);
  assert.equal(Object.hasOwn(publicCompleted, 'designerGuidance'), false);

  command('confirmDraft', { draftId: completed.draft.id });
  await waitFor(current => current.reviewRounds[0]?.status === 'completed');
  const next = command('assign', { text: 'Make the left margin wider.' }).result.jobId;
  await waitFor(current => current.job?.id === next && ['completed', 'awaitingApproval'].includes(current.job.status));
  assert.equal(designs.length, 2);
  assert.deepEqual(designs[1].task.history, [past]);
  assert.equal(designs[1].task.text, 'Make the left margin wider.');
});

test('late guidance restores editing tools after the read-only delivery turn', async t => {
  const requests = [];
  const guidance = [];
  const failures = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    const turn = requests.push(request);
    if (turn <= 7) return response(null, move(`move-${turn}`, 70 + turn));
    if (turn === 8) {
      assert.equal(request.tools, undefined);
      guidance.push(late);
      return response('The first arrangement is ready.');
    }
    if (turn === 9) {
      assert.ok(request.tools.some(item => item.function.name === 'run_canvas'));
      assert.ok(messageIndex(request.messages, late.text) >= 0);
      return response(null, move('move-with-late-guidance', 150));
    }
    assert.equal(turn, 10);
    assert.equal(request.tools, undefined);
    return response(delivered);
  });
  const result = await designer()(draftInput({ context: { previousError: 'The previous reply was incomplete.' } }), { validateDraft: preview, takeGuidance: async () => [...guidance],
    onTrace: trace => { if (trace.status === 'error') failures.push(`${trace.tool}: ${trace.output?.error}`); },
  }).catch(error => assert.fail([error.message, ...failures, `Requested ${requests.length} turns`].join('\n')));
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 10);
  assert.ok(messageIndex(requests[0].messages, 'The previous reply was incomplete.') >= 0);
  assert.equal(result.patches.at(-1).set.x, 150);
  assert.equal(result.reply, delivered);
  assert.deepEqual(result.memory.guidance, [late]);
});
