import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyPatch } from './poster.mjs';
import * as poster from './poster-render.mjs';
import { projectTheme } from './project-theme.mjs';
import { createSessions, publicState } from './sessions.mjs';
import { openStore } from './storage.mjs';

const feedback = ({ role, version }) => ({ role, text: `${version} ${role} proposes a change.`, mood: 'firm', mode: 'online' });
const silence = ({ role }) => ({ role, mode: 'online', skipped: true, text: '', speech: '' });

async function startFixture(t, { meetingResponse = feedback, beforeDesign } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-meeting-'));
  const store = openStore(dir);
  const designs = [];
  const deliveredGuidance = [];
  const replies = [];
  const reviews = [];
  t.mock.method(Math, 'random', () => 0.5);
  const sessions = createSessions(store, {
    poster, autoSchedule: false, stepMs: 0,
    getDialogueModel: () => ({
      async meetingTurn(input) {
        reviews.push(input);
        return meetingResponse(input);
      }
    }),
    getDesignerModel: () => async (task, { validateDraft, takeGuidance }) => {
      designs.push(task);
      await beforeDesign?.(task);
      const guidance = await takeGuidance?.() ?? [];
      deliveredGuidance.push(guidance);
      const title = task.scene.elements.find(layer => layer.id === 'title');
      const patches = [{ op: 'set', id: 'title', set: { x: title.x + 2 } }];
      await validateDraft(applyPatch(task.scene, patches).scene);
      const reply = task.initial ? 'I adjusted the headline alignment.' : `I applied the client notes in revision ${designs.length - 1}.`;
      replies.push(reply);
      return { patches, label: 'Headline alignment', elementIds: ['title'], reply,
        memory: { instruction: task.text, reply, guidance, at: Date.now() } };
    },
  });
  t.after(() => {
    sessions.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = projectTheme(undefined, { topic: 'Summer Concert', brief: 'A neighborhood concert.' });
  const created = await sessions.newSession(project, 'https://example.invalid/reservation', false, 'en');
  const { id } = created;
  const advance = () => sessions.advance(id);
  const command = (type, payload, commandId = crypto.randomUUID()) => {
    const receipt = sessions.command(id, { id: commandId, type, payload });
    assert.equal(receipt.error, undefined);
    return receipt;
  };
  async function until(predicate) {
    for (let index = 0; index < 30; index++) {
      const state = await advance();
      if (predicate(state)) return state;
    }
    assert.fail('The session failed to reach the expected state.');
  }
  async function publishFirstDraft() {
    const staged = await until(state => state.job.status === 'awaitingApproval');
    return command('confirmDraft', { draftId: staged.draft.id }).state;
  }
  function restoreOldRoundFlags(roundId) {
    const change = store.change(id, null, state => {
      const round = state.reviewRounds.find(item => item.id === roundId);
      assert.ok(round);
      Object.assign(round, { autoAssign: false, assignmentPending: false });
      return { events: [{ type: 'fixture-state', seq: ++state.seq }] };
    });
    return publicState(change.state);
  }
  return { created, command, advance, until, publishFirstDraft, designs, deliveredGuidance, replies, reviews, restoreOldRoundFlags, events: () => store.events(id) };
}

function assertSharedHandoff(f, version, reply) {
  const reviews = f.reviews.filter(review => review.version === version.id);
  assert.ok(reviews.length >= 3);
  assert.deepEqual([...new Set(reviews.map(review => review.role))], ['zhou', 'lin', 'tang']);
  const first = reviews[0].context.meeting.completion;
  assert.ok(first.notice.includes(version.id));
  assert.equal(first.designerSpeech, reply);
  for (const review of reviews) {
    assert.deepEqual(review.context.meeting.completion, first);
    const prefix = 'data:image/png;base64,';
    assert.ok(review.imageDataUrl.startsWith(prefix));
    const bytes = Buffer.from(review.imageDataUrl.slice(prefix.length), 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), version.pngHash);
  }
}

test('all eligible reviews automatically forward their own client remarks through V04, including a legacy stalled round', async t => {
  const f = await startFixture(t, { meetingResponse: input => input.version === 'V04' ? silence(input) : feedback(input) });
  assert.equal(f.created.meetingApprovalRequired, false);
  await f.publishFirstDraft();
  await f.advance();
  const note = { source: 'voice', text: 'Please keep the date clear.' };
  f.command('meetingInterject', note, 'first-note');
  assert.equal(f.command('meetingInterject', note, 'first-note').duplicate, true);
  const published = await f.until(state => state.versions.length === 2);
  assert.equal(published.job.status, 'completed');
  assert.equal(published.job.versionId, 'V02');
  assert.equal(published.draft, null);
  assert.equal(f.designs.length, 2);
  assert.ok(!f.designs[1].text.includes(note.text));
  assert.ok(!JSON.stringify(f.designs[1].context).includes(note.text));
  assert.deepEqual(f.deliveredGuidance[1].map(item => item.text), [note.text]);

  const checked = await f.until(state => state.reviewRounds[1]?.status === 'completed');
  assert.equal(checked.reviewRounds[1].autoAssign, true);
  assert.equal(checked.reviewRounds[1].assignmentPending, true);
  assert.equal(checked.reviewRounds[1].turnCount, 3);
  const oldRound = f.restoreOldRoundFlags('V02-review').reviewRounds[1];
  assert.equal(oldRound.assignmentPending, true);
  assert.deepEqual(oldRound.feedbackMessageIds, checked.reviewRounds[1].feedbackMessageIds);
  assert.equal((await f.advance()).job.meetingRoundId, 'V02-review');

  const final = await f.until(state => state.reviewRounds[3]?.status === 'completed');
  assert.deepEqual(final.versions.map(version => version.id), ['V01', 'V02', 'V03', 'V04']);
  assert.deepEqual(final.versions.slice(1).map(version => version.parentId), ['V01', 'V02', 'V03']);
  assert.equal(f.designs.length, 4);
  const names = { zhou: 'Director Zhou', lin: 'Lin Chi', tang: 'A-Tang' };
  for (const [index, round] of final.reviewRounds.entries()) {
    assertSharedHandoff(f, final.versions[index], f.replies[index]);
    assert.equal(round.assignmentPending, false);
    assert.deepEqual(round.feedbackMessageIds, []);
    if (!final.versions[index + 1]) continue;
    const messages = final.messages.filter(message => message.roundId === round.id);
    assert.deepEqual(messages.map(message => message.role), ['zhou', 'lin', 'tang']);
    const instruction = messages.map(message => `${names[message.role]}\n${message.text}`).join('\n\n');
    assert.equal(f.designs[index + 1].text, instruction);
    assert.deepEqual(final.versions[index + 1].source.messageIds, messages.map(message => message.id));
  }
  for (const review of f.reviews) {
    assert.ok(review.context.meeting.turns.every(turn => ['zhou', 'lin', 'tang'].includes(turn.role)));
    assert.ok(!JSON.stringify(review.context).includes(note.text));
  }
  assert.equal((await f.advance()).job.id, final.job.id);
  assert.deepEqual(f.events().filter(event => event.type === 'meeting-assignment-started').map(event => event.data.roundId),
    ['V01-opening', 'V02-review', 'V03-review']);
  assert.equal(f.events().filter(event => event.type === 'job-awaiting-approval').length, 1);
  assert.equal(f.events().filter(event => event.type === 'job-completed' && event.data.automatic === true).length, 3);
  assert.deepEqual(f.deliveredGuidance[2], []);
  assert.deepEqual(f.designs[2].history.at(-1).guidance.map(item => item.text), [note.text]);
});

test('approval mode waits for an explicit assignment release and a later publication confirmation', async t => {
  const f = await startFixture(t);
  assert.equal(f.command('setMeetingApproval', { required: true }).state.meetingApprovalRequired, true);
  await f.publishFirstDraft();
  const draftId = f.command('restore', { versionId: 'V01' }).result.draftId;
  await f.until(state => state.reviewRounds[0].status === 'completed');
  const held = await f.advance();
  assert.equal(held.draft.id, draftId);
  assert.equal(held.job.initial, true);
  f.command('discardDraft', { draftId });
  const awaitingRelease = await f.advance();
  assert.equal(awaitingRelease.job.initial, true);
  assert.equal(awaitingRelease.reviewRounds[0].assignmentPending, true);
  assert.equal(f.designs.length, 1);
  const release = { roundId: 'V01-opening' };
  const queued = f.command('releaseMeetingAssignment', release, 'release-v01').state.reviewRounds[0];
  assert.equal(queued.releaseRequested, true);
  assert.equal(f.command('releaseMeetingAssignment', release, 'release-v01').duplicate, true);
  const staged = await f.until(state => state.job.status === 'awaitingApproval');
  assert.equal(staged.versions.length, 1);
  assert.equal((await f.advance()).draft.id, staged.draft.id);
  const confirmed = f.command('confirmDraft', { draftId: staged.draft.id }).state;
  assert.equal(confirmed.versions.length, 2);
  const reviewed = await f.until(state => state.reviewRounds[1]?.status === 'completed');
  assert.equal(reviewed.reviewRounds[1].assignmentPending, true);
  const oldRound = f.restoreOldRoundFlags('V02-review').reviewRounds[1];
  assert.equal(oldRound.assignmentPending, true);
  assert.deepEqual(oldRound.feedbackMessageIds, reviewed.reviewRounds[1].feedbackMessageIds);
  assert.equal((await f.advance()).job.id, confirmed.job.id);
  assertSharedHandoff(f, reviewed.versions[1], f.replies[1]);
  f.command('releaseMeetingAssignment', { roundId: 'V02-review' });
  const nextDraft = await f.until(state => state.job.status === 'awaitingApproval');
  assert.equal(nextDraft.job.meetingRoundId, 'V02-review');
  assert.equal(nextDraft.versions.length, 2);
  assert.equal(f.command('confirmDraft', { draftId: nextDraft.draft.id }).state.versions.at(-1).id, 'V03');
});

test('three silent online reviewers receive the same confirmed handoff and never create dialogue or an edit assignment', async t => {
  const f = await startFixture(t, { meetingResponse: silence });
  await f.publishFirstDraft();
  const state = await f.until(current => ['completed', 'failed'].includes(current.reviewRounds[0]?.status));
  assert.equal(state.reviewRounds[0].status, 'completed');
  assert.equal(state.reviewRounds[0].turnCount, 3);
  assert.equal(state.reviewRounds[0].assignmentPending, false);
  assert.deepEqual(f.reviews.map(review => review.role), ['zhou', 'lin', 'tang']);
  assert.equal(new Set(f.reviews.map(review => review.imageDataUrl)).size, 1);
  for (const review of f.reviews) {
    assert.match(review.imageDataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(review.context, f.reviews[0].context);
    assert.equal(review.context.meeting.completion.designerSpeech, 'I adjusted the headline alignment.');
    assert.deepEqual(review.context.meeting.turns, []);
  }
  assert.equal(state.messages.some(message => ['zhou', 'lin', 'tang'].includes(message.role)), false);
  assert.equal(f.events().some(event => event.type === 'dialogue' && ['zhou', 'lin', 'tang'].includes(event.role)), false);
  await f.advance();
  assert.equal(f.designs.length, 1);
});

test('one named objection adds only the targeted client after all three initial turns', async t => {
  const f = await startFixture(t, { meetingResponse: ({ role, context }) => {
    if (role === 'lin') return { role, mode: 'online', text: 'Zhou, moving the title would crowd the sponsor mark.', challengeRole: 'zhou' };
    if (role === 'zhou' && context.meeting.turns.some(turn => turn.role === 'zhou')) {
      return { role, mode: 'online', text: 'Keep the title in place and increase its contrast.' };
    }
    return { role, mode: 'online', text: 'Increase the date size.' };
  } });
  await f.publishFirstDraft();
  const reviewed = await f.until(state => state.reviewRounds[0]?.status === 'completed');
  assert.deepEqual(f.reviews.map(review => review.role), ['zhou', 'lin', 'tang', 'zhou']);
  assert.equal(f.reviews[3].replyTo.role, 'lin');
  assert.equal(reviewed.reviewRounds[0].turnCount, 4);
  assert.equal(reviewed.reviewRounds[0].rebuttals, 1);
});

test('automatic feedback waits while a failed job or an unconfirmed draft needs the manager', async t => {
  const instruction = 'Make a manual adjustment first.';
  let manualAttempts = 0;
  const f = await startFixture(t, { beforeDesign(task) {
    if (task.text === instruction && ++manualAttempts === 1) throw new Error('A controlled designer failure.');
  } });
  await f.publishFirstDraft();
  const { jobId } = f.command('assign', { text: instruction }).result;
  const blocked = await f.until(state => state.reviewRounds[0]?.status === 'completed');
  assert.equal(blocked.job.id, jobId);
  assert.equal(blocked.job.status, 'failed');
  assert.equal(blocked.reviewRounds[0].assignmentPending, true);
  assert.equal((await f.advance()).job.id, jobId);

  f.command('retry', { jobId });
  const held = await f.until(state => state.job.status === 'awaitingApproval');
  assert.equal(held.job.id, jobId);
  assert.equal(held.reviewRounds[0].assignmentPending, true);
  assert.equal((await f.advance()).draft.id, held.draft.id);
  assert.equal(f.events().filter(event => event.type === 'meeting-assignment-started').length, 0);

  f.command('discardDraft', { draftId: held.draft.id });
  const resumed = await f.advance();
  assert.equal(resumed.job.meetingRoundId, 'V01-opening');
  assert.notEqual(resumed.job.id, jobId);
});

test('the original and revised first poster stay unpublished until the manager confirms a specific draft', async t => {
  const f = await startFixture(t, { meetingResponse: silence });
  const staged = await f.until(state => state.job.status === 'awaitingApproval');
  assert.equal(staged.draft.baseVersionId, null);
  assert.equal(staged.selectedVersionId, null);
  assert.deepEqual(staged.versions, []);
  assert.deepEqual((await f.advance()).reviewRounds, []);
  assert.deepEqual(staged.draft.paper, { widthMm: 297, heightMm: 420, format: 'A3' });

  f.command('assign', { text: 'Move the title slightly to the right.', baseVersionId: null });
  const revised = await f.until(state => state.job.status === 'awaitingApproval');
  assert.notEqual(revised.draft.id, staged.draft.id);
  assert.equal(revised.draft.iteration, 2);
  assert.equal(f.designs[1].draftId, staged.draft.id);
  assert.equal(f.designs[1].text, 'Move the title slightly to the right.');
  assert.deepEqual((await f.advance()).versions, []);
  assert.equal(f.reviews.length, 0);

  const confirmed = f.command('confirmDraft', { draftId: revised.draft.id }).state;
  assert.equal(confirmed.draft, null);
  assert.equal(confirmed.versions[0].id, 'V01');
  assert.equal(confirmed.versions[0].pngHash, revised.draft.pngHash);
  assert.equal(confirmed.job.status, 'completed');
  assert.equal(confirmed.reviewRounds.length, 1);
  const reviewed = await f.until(state => state.reviewRounds[0].status === 'completed');
  assertSharedHandoff(f, reviewed.versions[0], f.replies[1]);
});

test('returned remarks wait for the next publication and only approved remarks enter Xiao Yi’s assignment', async t => {
  const f = await startFixture(t);
  f.command('setMeetingApproval', { required: true });
  await f.publishFirstDraft();
  const reviewed = await f.until(state => state.reviewRounds[0]?.status === 'completed');
  const roundId = reviewed.reviewRounds[0].id;
  const [zhou, lin, tang] = reviewed.reviewRounds[0].feedbackMessageIds;
  const note = 'Keep this margin for the accessibility logo.';
  const decision = (messageId, action, text) => f.command('reviewMeetingFeedback', { roundId, messageId, decision: action, text }).state.reviewRounds[0];
  decision(zhou, 'return', note);
  decision(lin, 'return');
  const allReturned = decision(tang, 'return');
  assert.equal(allReturned.assignmentPending, false);
  assert.deepEqual(allReturned.feedbackMessageIds, []);
  assert.deepEqual(allReturned.reviewableFeedbackMessageIds, [zhou, lin, tang]);
  assert.equal((await f.advance()).job.initial, true);
  assert.equal(f.reviews.length, 3);
  assert.equal(f.designs.length, 1);

  decision(lin, 'restore');
  assert.deepEqual(decision(tang, 'restore').feedbackMessageIds, [lin, tang]);
  f.command('releaseMeetingAssignment', { roundId });
  const staged = await f.until(state => state.job.status === 'awaitingApproval');
  assert.deepEqual(staged.job.sourceIds, [lin, tang]);
  assert.doesNotMatch(f.designs[1].text, /V01 zhou proposes|accessibility logo/);
  assert.match(f.designs[1].text, /V01 lin proposes/);
  assert.match(f.designs[1].text, /V01 tang proposes/);
  assert.equal(f.reviews.length, 3);

  f.command('confirmDraft', { draftId: staged.draft.id });
  await f.until(state => state.reviewRounds[1]?.status === 'completed');
  for (const review of f.reviews.slice(3)) {
    assert.deepEqual(review.context.meeting.completion.managerFeedback,
      [{ role: 'zhou', versionId: 'V01', originalText: 'V01 zhou proposes a change.', text: note }]);
  }
});
