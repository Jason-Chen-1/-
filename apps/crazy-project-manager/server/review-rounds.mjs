import { projectDialogueLine, projectRequirement, roleLanguage } from './role-language.mjs';
import { designerSpeech } from '../shared/designer-speech.mjs';

export const clientRoles = ['zhou', 'lin', 'tang'];
export const roundLimits = Object.freeze({ turns: 5, rebuttals: 2, requirements: 3 });
const reviewKinds = new Set(['opening', 'review', 'rebuttal']);
const assignmentBlockingJobs = new Set(['planning', 'working', 'paused', 'failed', 'awaitingApproval']);
const silenceOnly = /^(?:\[\[PASS\]\]|我这轮就这些[。.!！]?|that['’]s all from me for this round[。.!！]?)$/i;

export function pendingRound(state) {
  return state.reviewRounds?.find(round => round.status === 'running') ?? state.reviewRounds?.find(round => round.status === 'queued');
}

export function pendingMeetingReview(state) {
  const latestVersion = state.versions.at(-1)?.id;
  const round = latestVersion && state.reviewRounds?.findLast(item => item.versionId === latestVersion);
  if (!round || round.status !== 'completed' || (round.meetingMode ?? state.meetingMode) === false ||
      round.assignmentJobId || state.job?.meetingRoundId === round.id) return null;
  const feedback = meetingFeedback(state, round);
  if (!feedback.length) return null;
  const returned = new Set((round.managerFeedback ?? []).map(item => item.messageId));
  return { round, feedback: feedback.filter(turn => !returned.has(turn.id)), reviewable: feedback };
}

export function pendingMeetingAssignment(state) {
  const review = pendingMeetingReview(state);
  return review?.feedback.length ? review : null;
}

export function readyMeetingAssignment(state) {
  if (state.draft || assignmentBlockingJobs.has(state.job?.status)) return null;
  const round = pendingMeetingAssignment(state)?.round;
  return round && (round.managerRequestedAssignment === true || state.meetingApprovalRequired !== true) ? round : null;
}

export function reviewRoundView(round, oldPngHash = null, pendingReview = null) {
  const meetingMode = round.meetingMode !== false;
  const feedbackMessageIds = pendingReview?.feedback.map(turn => turn.id) ?? [];
  const assignmentPending = feedbackMessageIds.length > 0;
  return {
    id: round.id, versionId: round.versionId, status: round.status, phase: round.phase,
    turnCount: round.turnCount, maxTurns: roundLimits.turns, rebuttals: round.rebuttals,
    pngHash: round.snapshot ? round.snapshot.pngHash : oldPngHash,
    pngReaders: clientRoles.filter(role => round.imageReads?.[role] === 'completed'), error: round.error ?? null,
    meetingMode, activeTurnId: round.active?.ticket ?? null, autoAssign: meetingMode,
    assignmentJobId: round.assignmentJobId ?? null, assignmentPending, feedbackMessageIds,
    reviewableFeedbackMessageIds: pendingReview?.reviewable.map(turn => turn.id) ?? [],
    managerFeedback: round.managerFeedback ?? [],
    releaseRequested: assignmentPending && round.managerRequestedAssignment === true,
  };
}

export function roundSnapshot(version, project, completion) {
  return {
    pngHash: /^[a-f0-9]{64}$/.test(version.pngHash ?? '') ? version.pngHash : null,
    project: structuredClone(project), review: structuredClone(version.review ?? {}),
    ...(completion && { completion: { notice: completion.notice, designerSpeech: designerSpeech(completion.designerSpeech),
      ...(completion.managerFeedback?.length && { managerFeedback: completion.managerFeedback }) } }),
  };
}

export function makeReviewRound(versionId, phase, seeds, commandId, snapshot, meetingMode = true) {
  const firstByRole = new Map();
  for (const seed of seeds) if (!firstByRole.has(seed.role)) firstByRole.set(seed.role, seed);
  return {
    id: `${versionId}-${phase}`, versionId, phase, commandId, status: 'queued', meetingMode,
    turnCount: 0, rebuttals: 0, messageIds: [], rolesSpoken: [], imageReads: {},
    seeds: Object.fromEntries(firstByRole), unsaid: Array.from(firstByRole.keys()), next: null, active: null,
    ...(snapshot ? { snapshot } : {})
  };
}

export function nextRoundSlot(round, now = Date.now()) {
  if (round.status === 'completed' || round.status === 'failed' || round.turnCount >= roundLimits.turns) return null;
  if (round.active) return round.active.expiresAt <= now ? round.active.slot : null;
  return round.next ?? (round.unsaid.length ? { role: round.unsaid[0], replyTo: null, rebuttal: false } : null);
}

function legacyMeetingProgress(rolesSpoken) {
  const progress = {};
  for (const role of rolesSpoken) progress[role] = { count: (progress[role]?.count ?? 0) + 1 };
  return progress;
}

export function recordRoundTurn(round, message, slot, challengeRole, { meeting = false, skipped = false } = {}) {
  const role = meeting ? slot.role : message.role;
  if (meeting) round.meetingProgress ??= legacyMeetingProgress(round.rolesSpoken);
  round.active = null;
  round.next = null;
  round.turnCount++;
  if (message && !skipped) {
    round.messageIds.push(message.id);
    round.rolesSpoken.push(message.role);
  }
  round.unsaid = round.unsaid.filter(item => item !== role);
  if (slot.rebuttal) round.rebuttals++;

  if (meeting) {
    const progress = round.meetingProgress;
    progress[role] = { count: (progress[role]?.count ?? 0) + 1 };
    const challenges = round.meetingChallenges ??= [];
    if (message && !skipped && clientRoles.includes(challengeRole) && challengeRole !== role &&
        round.rolesSpoken.includes(challengeRole) && progress[challengeRole]?.count === 1) {
      const queued = challenges.find(item => item.role === challengeRole);
      if (queued) queued.replyTo = message.id;
      else if (round.rebuttals + challenges.length < roundLimits.rebuttals) {
        challenges.push({ role: challengeRole, replyTo: message.id, rebuttal: true });
      }
    }
    if (round.unsaid.length && round.turnCount < roundLimits.turns) return;
    if (challenges.length && round.turnCount < roundLimits.turns && round.rebuttals < roundLimits.rebuttals) {
      round.next = challenges.shift();
    } else {
      round.status = 'completed';
      round.assignmentPending = round.messageIds.length > 0;
    }
    return;
  }

  if (round.turnCount < roundLimits.turns && clientRoles.includes(challengeRole) && challengeRole !== message.role) {
    const first = round.unsaid.includes(challengeRole);
    const times = round.rolesSpoken.filter(role => role === challengeRole).length;
    const space = roundLimits.turns - round.turnCount > round.unsaid.length;
    if (first || (space && times < 2 && round.rebuttals < roundLimits.rebuttals)) {
      round.next = { role: challengeRole, replyTo: message.id, rebuttal: !first };
    }
  }
  if (round.turnCount >= roundLimits.turns || (!round.next && !round.unsaid.length)) round.status = 'completed';
}

export function requirementList(line) {
  const entries = [line.requirement, ...(Array.isArray(line.requirements) ? line.requirements : [])].filter(Boolean);
  const ids = new Set();
  const content = new Set();
  return entries.filter(entry => {
    const details = [entry.text, entry.goal, entry.instruction, entry.condition, entry.concession]
      .map(value => typeof value === 'string' ? value.trim() : '');
    const signature = details.some(Boolean) ? JSON.stringify([...details, entry.stage, entry.elementIds, entry.conflictsWith]) : '';
    if (entry.id ? ids.has(entry.id) : !signature || content.has(signature)) return false;
    if (entry.id) ids.add(entry.id);
    if (signature) content.add(signature);
    return true;
  }).slice(0, roundLimits.requirements);
}

export function meetingHistory(state, round, language) {
  const committed = new Set(round.messageIds ?? []);
  return state.messages.filter(message => (message.roundId === round.id && message.kind === 'meeting-interjection') ||
      (committed.has(message.id) && (!message.roundId || message.roundId === round.id)))
    .map(message => language ? projectDialogueLine(message, language) : message)
    .map(({ id, role, text, speech, kind, replyTo, elementIds, turnId }) => ({ id, role, text: text || speech, kind, replyTo, elementIds, turnId }));
}

export function meetingFeedback(state, round) {
  return meetingHistory(state, round).filter(turn => {
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    return clientRoles.includes(turn.role) && text && !silenceOnly.test(text);
  });
}

function meetingCompletion(state, version, round) {
  const snapshot = round?.snapshot?.completion;
  if (snapshot) return snapshot;
  const handoff = state.messages.find(message => message.role === 'yi' && message.kind === 'job' && message.versionId === version.id);
  return {
    notice: `${version.id} 已完成，等待评审。 ${version.id} is ready for review.`,
    designerSpeech: designerSpeech(handoff?.speech ?? handoff?.text ?? (state.job?.id === version.jobId ? state.job?.reply : '')),
  };
}

export function contextFor(state, role, version, round) {
  const language = roleLanguage(state.language ?? state.lang);
  const active = round ?? state.reviewRounds?.findLast(item => item.versionId === version.id);
  if (active && (active.meetingMode ?? state.meetingMode) !== false) {
    return { language, meeting: { roundId: active.id, completion: meetingCompletion(state, version, active), turns: meetingHistory(state, active) } };
  }
  const byId = new Map(state.messages.map(message => [message.id, message]));
  const peerTurns = (active?.messageIds ?? []).map(id => byId.get(id)).filter(message => message && clientRoles.includes(message.role)).map(message => {
    const turn = projectDialogueLine(message, language);
    return {
      id: turn.id, role: turn.role, text: turn.text, elementIds: turn.elementIds ?? [], replyTo: turn.replyTo ?? null,
      versionId: turn.versionId, requirements: requirementList(turn).map(requirement => ({ ...requirement, role: turn.role })),
    };
  });
  const priorVersions = new Set();
  for (const item of state.versions ?? []) {
    if (item.id === version.id) break;
    priorVersions.add(item.id);
  }
  const shared = active?.snapshot;
  const scene = version.scene;
  return {
    language, peerTurns,
    completion: meetingCompletion(state, version, active),
    snapshot: {
      roundId: active?.id, versionId: version.id, label: version.label,
      pngHash: shared ? shared.pngHash : version.pngHash, width: scene?.width, height: scene?.height,
      layers: scene?.elements?.map(({ id, label, x, y, w, h, hidden }) => ({ id, label, x, y, w, h, hidden })) ?? [],
    },
    elementIds: scene?.elements?.map(layer => layer.id) ?? [],
    memory: (state.agentMemory?.[role] ?? []).slice(-8),
    history: state.messages.filter(message => clientRoles.includes(message.role) && priorVersions.has(message.versionId) && reviewKinds.has(message.kind))
      .slice(-18).map(message => projectDialogueLine(message, language)).map(message => ({
      id: message.id, role: message.role, text: message.text, versionId: message.versionId, replyTo: message.replyTo
    })),
    requirements: state.requirements.filter(item => item.role === role && (!item.versionId || item.versionId === version.id || priorVersions.has(item.versionId)))
      .slice(-12).map(item => projectRequirement(item, language))
      .map(({ id, role, text, status, instruction, displayInstruction, goal, condition, concession, elementIds }) => ({ id, role, text, status, instruction, displayInstruction, goal, condition, concession, elementIds })),
    review: shared?.review ?? version.review,
    changedElements: (version.diff ?? []).map(item => item.id)
  };
}
