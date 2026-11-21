import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { designerSpeech } from '../shared/designer-speech.mjs';
import { applyPatch, applyUpload, verifyUploadPng } from './poster.mjs';
import { buildIssues, reviewScene } from './poster-review.mjs';
import { canvasDimensions } from './poster-paper.mjs';
import { httpError } from './errors.mjs';
import { prepareCanvasEdits, sceneAssetHashes } from './designer-model.mjs';
import { amdDesignerTimeoutMs, createDesignerImageGenerator, imageGenerationContext, projectMaterialLimit, saveProjectMaterial } from './designer-image.mjs';
import { createInitialPoster } from './initial-poster.mjs';
import { recordTools, toolResult } from './tool-trace.mjs';
import { projectDialogueLine, projectRequirement, roleLanguage } from './role-language.mjs';
import { clientRoles as CLIENTS, contextFor, makeReviewRound, nextRoundSlot, pendingMeetingAssignment, pendingMeetingReview, pendingRound, readyMeetingAssignment, recordRoundTurn, requirementList, reviewRoundView, roundSnapshot } from './review-rounds.mjs';

const BUSY = new Set(['planning', 'working', 'paused']);
const randomUUID = () => globalThis.crypto.randomUUID();
const timedJob = job => job?.status === 'working' || (job?.status === 'paused' && job.autoResume === true);
const slackProgress = [20, 30, 40, 60, 70, 80];
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const roundImages = new Map();
const maxCachedImageCharacters = 8_000_000;
const firstDraftLabel = { 'zh-CN': '项目初稿', en: 'First poster draft' };
const pendingGuidance = (state, ticket) => (state.designerGuidance ?? []).filter(item => !ticket || item.ticket !== ticket);

export function readyDesignerGuidance(state) {
  return Boolean((state.versions.length || state.draft) && !BUSY.has(state.job?.status) && state.job?.status !== 'failed' &&
    !pendingRound(state) && pendingGuidance(state).some(item => item.kind !== 'rush'));
}
const agentErrors = {
  unconfigured: ['请在设置中配置在线 Agent 后重试。', 'Configure an online agent in Settings, then try again.'],
  timeout: ['在线 Agent 响应超时，请重试。', 'The online agent timed out. Try again.'],
  'output-limit': ['模型达到输出长度上限，请重试本次工单。', 'The model hit its output limit. Retry this assignment.'],
  'empty-output': ['在线 Agent 未提交有效结果，请重试。', 'The online agent returned no usable result. Try again.'],
  'poster-image': ['当前版本的 PNG 无法读取，请重试。', 'The confirmed PNG could not be read. Try again.'],
  'asset-unavailable': ['Agent 需要的项目素材无法读取，请检查素材后重试。', 'The requested project material could not be read. Check it and try again.'],
  'draft-changed': ['当前草稿已更新，请在最新稿上重试。', 'The draft changed. Try again with the latest draft.'],
  'draft-discarded': ['首稿已放弃，可以重新生成。', 'The first draft was discarded. You can create another.'],
  'render-error': ['海报未能出图，请重试。', 'The poster could not be rendered. Try again.'],
  'agent-error': ['在线 Agent 调用失败，请重试。', 'The online agent request failed. Try again.'],
};

function agentError(code, detail) {
  return Object.assign(new Error(detail ?? code), { agentCode: code });
}

function agentFailure(error, language) {
  const code = Object.hasOwn(agentErrors, error?.agentCode) ? error.agentCode : error?.name === 'TimeoutError' ? 'timeout' : 'agent-error';
  const detail = Number.isInteger(error?.upstreamStatus) ? `HTTP ${error.upstreamStatus}` : textOf(error?.message, 220)
    .replace(/(?:https?:\/\/[^\s]+|Bearer\s+[^\s]+|\b(?:sk|rk|key)[_-][\w-]{8,})/gi, '[redacted]').replace(/[\r\n\t]+/g, ' ');
  const summary = agentErrors[code][roleLanguage(language) === 'en' ? 1 : 0];
  return { code, message: detail && detail !== code ? `${summary} (${detail})` : summary };
}

function requeueDesignJob(job) {
  if (job.error) job.previousError = { code: job.errorCode ?? 'agent-error', message: job.error };
  Object.assign(job, { status: 'planning', progress: 0, dueAt: null, error: null, errorCode: null, agentPlanned: false });
  for (const key of ['planClaim', 'patches', 'reply', 'fallbackPlan', 'designMemory', 'guidanceTicket']) delete job[key];
}

function checkFirstDraftFacts(scene, facts) {
  const normalize = value => String(value ?? '').normalize('NFC').replace(/\s+/g, '');
  const visible = layer => layer && !layer.hidden && (layer.style?.opacity ?? 1) > 0;
  const { title, info, credits } = Object.fromEntries(scene.elements.map(layer => [layer.id, layer]));
  if (!visible(title) || normalize(title.text) !== normalize(facts.title)) throw new Error('初稿需要保留项目主题。');
  for (const key of ['date', 'hours', 'venue', 'gate']) {
    if (normalize(info?.[key]) !== normalize(facts[key]) || (facts[key] && !visible(info))) throw new Error('初稿需要使用简报里的活动信息。');
  }
  if (facts.credits && (!visible(credits) || normalize(credits.text) !== normalize(facts.credits))) throw new Error('初稿需要保留简报的主办方署名。');
}

const roundImageKey = (sessionId, task) => `${sessionId}:${task.roundId}:${task.imageHash}`;

function cacheRoundImage(key, data) {
  if (data.length > maxCachedImageCharacters) return;
  const now = Date.now();
  for (const [id, entry] of roundImages) {
    if (entry.expiresAt <= now) roundImages.delete(id);
  }
  roundImages.set(key, { data, expiresAt: now + 180_000 });
  let characters = [...roundImages.values()].reduce((sum, entry) => sum + entry.data.length, 0);
  while (roundImages.size > 24 || characters > maxCachedImageCharacters) {
    const oldest = roundImages.keys().next().value;
    characters -= roundImages.get(oldest).data.length;
    roundImages.delete(oldest);
  }
}

function textOf(value, limit = 1200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

export const posterUrl = (sessionId, versionId, format = 'svg') =>
  `/api/sessions/${sessionId}/versions/${versionId}/poster.${format}`;

const visibleLayers = scene => scene.elements.map(({ id, label, x, y, w, h }) => ({ id, label, x, y, w, h }));

function versionView({ scene, ...version }) {
  return { ...version, ...canvasDimensions(scene), elements: visibleLayers(scene) };
}

function draftView(draft, sessionId) {
  if (!draft) return null;
  const { id, baseVersionId, label, updatedAt, hash, pngHash, iteration, scene } = draft;
  return { id, baseVersionId, label, updatedAt, hash, pngHash, iteration, ...canvasDimensions(scene), elements: visibleLayers(scene),
    previewUrl: `/api/sessions/${sessionId}/draft/poster.svg?draft=${encodeURIComponent(id)}` };
}

function jobView(job) {
  if (!job) return null;
  const { patches, reply, dueAt, operation, planClaim, fallbackPlan, requestedSources, requestedMaterials, previousError,
    agentPlanned, slackAt, imageGenerations, designMemory, guidanceTicket, autoPublish, ...view } = job;
  return view;
}

export function publicState(state) {
  const { versions, draft, job, pendingTurn, pendingQuestions, agentMemory, designerMemory, designerGuidance,
    reviewRounds, reveals, nextJob, reservationUrl, reservationVerified, lastAt, ...view } = state;
  const versionImages = new Map(versions.map(version => [version.id, version.pngHash]));
  const pendingReview = pendingMeetingReview(state);
  return { ...view, meetingMode: state.meetingMode !== false, meetingApprovalRequired: state.meetingApprovalRequired === true,
    toolTraces: view.toolTraces ?? [], materials: view.materials ?? [], versions: versions.map(versionView),
    draft: draftView(draft, state.id), job: jobView(job), awaitingRole: null,
    reviewRounds: (reviewRounds ?? []).map(round => reviewRoundView(round, versionImages.get(round.versionId),
      round === pendingReview?.round ? pendingReview : null)) };
}

function frame(state) {
  return {
    selectedRole: state.selectedRole, selectedVersionId: state.selectedVersionId,
    job: jobView(state.job), finalizedVersionId: state.finalizedVersionId,
    draft: draftView(state.draft, state.id),
    issueCount: state.issues.filter(issue => issue.status !== 'resolved').length,
    slaps: state.slaps, mode: state.mode, meetingMode: state.meetingMode !== false, meetingApprovalRequired: state.meetingApprovalRequired === true,
  };
}

function transaction(state, commandId) {
  const before = state.seq;
  const events = [];
  return {
    state,
    emit(type, data = {}, meta = {}) {
      const at = Math.max(state.lastAt, Date.now());
      state.lastAt = at;
      const event = {
        seq: ++state.seq, type, at, elapsedMs: at - state.startedAt, data,
        role: meta.role ?? null, versionId: meta.versionId ?? state.selectedVersionId,
        commandId: meta.commandId ?? commandId ?? null, causationSeq: meta.causationSeq ?? null
      };
      events.push(event);
      return event;
    },
    finish(result, rejection) {
      if (events.length) events.at(-1).view = frame(state);
      const needsSnapshot = events.some(event => event.type === 'version' || event.type === 'session-start') ||
        Math.floor(before / 100) < Math.floor(state.seq / 100);
      return {
        events, result, error: rejection?.message, statusCode: rejection?.statusCode,
        snapshot: needsSnapshot ? { seq: state.seq, at: state.lastAt, view: frame(state) } : null
      };
    }
  };
}

function findVersion(state, id = state.selectedVersionId) {
  const version = state.versions.find(item => item.id === id);
  if (!version) throw httpError(404, '这个海报版本不存在。');
  return version;
}

function draftForVersion(state, base) {
  const draft = state.draft ?? null;
  if (draft && draft.baseVersionId !== (base?.id ?? null)) throw httpError(409, '请先确认或放弃当前草稿，再改另一版海报。');
  return draft;
}

function editableVersion(state, id = state.selectedVersionId) {
  return id == null && !state.versions.length && state.draft ? null : findVersion(state, id);
}

function sceneDifference(original, changed) {
  const snapshot = scene => new Map(scene.elements.map((layer, index) => [layer.id, { ...layer, index }]));
  const before = snapshot(original);
  const after = snapshot(changed);
  before.set('$canvas', canvasDimensions(original));
  after.set('$canvas', canvasDimensions(changed));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
    const previous = before.get(id) ?? null;
    const current = after.get(id) ?? null;
    return JSON.stringify(previous) === JSON.stringify(current) ? [] : [{ id, before: previous, after: current }];
  });
}

function requirementFrom(state, message, requirement) {
  const id = `${message.versionId}:${requirement.id}`;
  const index = state.requirements.findIndex(item => {
    if (item.id === id) return true;
    if (item.id !== requirement.id) return false;
    const versionId = item.versionId ?? state.messages.find(source => source.id === item.sourceMessageId)?.versionId;
    return versionId === message.versionId;
  });
  const prior = state.requirements[index];
  const translations = requirement.translations ?? Object.fromEntries(Object.entries(message.translations ?? {}).flatMap(([language, variant]) => {
    const translated = variant.requirements?.find(item => item.id === requirement.id);
    return translated ? [[language, translated]] : [];
  }));
  const updated = {
    ...prior, ...requirement, translations, id: prior?.id ?? id, role: message.role,
    text: requirement.instruction || requirement.goal || prior?.text || message.text,
    elementIds: requirement.elementIds ?? message.elementIds,
    originalMessageId: prior?.originalMessageId ?? message.id,
    sourceMessageId: message.id,
    sourceMessageIds: [...new Set([...(prior?.sourceMessageIds ?? []), message.id])],
    status: prior?.status ?? 'open', roundId: message.roundId ?? prior?.roundId ?? null, versionId: message.versionId
  };
  if (prior) state.requirements[index] = updated;
  else state.requirements.push(updated);
}

function appendMessage(tx, line, kind, versionId, info = {}) {
  const { state } = tx;
  const id = `M${state.messages.length + 1}`;
  const requirements = requirementList(line).map((requirement, index) => ({ ...requirement, id: requirement.id ?? `${id}-${index + 1}` }));
  const message = {
    ...line, id, kind, roundId: info.roundId ?? null, requirements, requirement: requirements[0] ?? null,
    versionId, elementIds: line.elementIds ?? [], replyTo: info.replyTo ?? line.replyTo ?? null,
    createdAt: Date.now()
  };
  state.messages.push(message);
  for (const requirement of requirements) requirementFrom(state, message, requirement);
  tx.emit('message', { message }, { role: line.role, versionId, commandId: info.commandId });
  return message;
}

function dialogue(tx, lines, { kind, versionId = tx.state.selectedVersionId, auto = true, remember = false, commandId, roundId } = {}) {
  const turns = [];
  for (const line of lines) {
    const replyTo = Number.isInteger(line.replyTo) ? turns[line.replyTo]?.id : line.replyTo;
    const requirements = requirementList(line).map(item => {
      if (!Number.isInteger(item.conflictsWith?.turnIndex)) return item;
      const { turnIndex, requirementId } = item.conflictsWith;
      const target = turns[turnIndex];
      return { ...item, conflictsWith: target ? { turnId: target.id, requirementId } : undefined };
    });
    turns.push(appendMessage(tx, { ...line, requirement: requirements[0] ?? null, requirements }, kind, versionId, { replyTo, commandId, roundId }));
  }
  if (!turns.length) return turns;
  if (remember && versionId === tx.state.selectedVersionId) tx.state.lastDialogue = turns;
  tx.emit('dialogue', { turns, auto, roundId }, { versionId, role: turns[0].role, commandId });
  return turns;
}

function employeeReply(tx, text, elementIds, versionId) {
  const speech = designerSpeech(text);
  if (!speech) return;
  const copy = { speech, text: speech };
  const translations = { 'zh-CN': copy, en: copy };
  dialogue(tx, [{ role: 'yi', mood: 'done', mode: 'online', elementIds, ...copy, translations }], { kind: 'job', versionId });
}

function markAssigned(state, sources) {
  for (const item of state.requirements) {
    if (sources.some(source => source.pickedRequirementId
      ? source.pickedRequirementId === item.id
      : item.sourceMessageIds.includes(source.id))) item.status = 'assigned';
  }
}

function resolveSources(state, ids) {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter(id => typeof id === 'string').slice(0, 30));
  const messages = state.messages.filter(message => wanted.has(message.id) && CLIENTS.includes(message.role));
  for (const requirement of state.requirements) {
    if (!wanted.has(requirement.id) || wanted.has(requirement.sourceMessageId)) continue;
    const source = state.messages.find(message => message.id === requirement.sourceMessageId);
    if (source) messages.push({ ...source, requirement, requirements: [requirement], pickedRequirementId: requirement.id });
  }
  return messages;
}

function comparisonReview(review, parent, versions) {
  return Object.fromEntries(CLIENTS.map(role => {
    const result = review[role];
    const reference = [parent, ...versions.slice().reverse()].find(version => version &&
      !version.review[role].pendingWeight && Number.isFinite(version.review[role].score));
    const previousScore = reference?.review[role].score ?? null;
    return [role, {
      ...result, previousScore, referenceScore: result.pendingWeight ? previousScore : null,
      referenceVersionId: reference?.id ?? null,
      delta: Number.isFinite(result.score) && previousScore !== null && !result.pendingWeight ? result.score - previousScore : null
    }];
  }));
}

export function createSessions(store, { poster, stepMs = 220, getDialogueModel = () => null, getDesignerModel = () => null, getImageConfig = () => null,
  publish = () => {}, onMeetingChunk = () => {}, onDesignerSpeech = () => {}, autoSchedule = true } = {}) {
  const { posterSVG, rasterizePoster, verifyPosterQR, initializePoster } = poster;
  const clocks = new Map();
  const speaking = new Map();
  let closed = false;

  function renderProjectPoster(tx, scene, { runId, versionId } = {}) {
    const { state } = tx;
    // Work with immutable authored scene data. Only the renderer reads the uploaded asset bytes.
    const authored = structuredClone(scene);
    const materialized = hydrateScene(authored);
    const svgAt = Date.now();
    const svg = posterSVG(materialized);
    const pngAt = Date.now();
    const raster = rasterizePoster(svg);
    const pngDone = Date.now();
    if (raster.width !== authored.width || raster.height !== authored.height) throw new Error('海报尺寸与画布不一致');
    const qr = verifyPosterQR(materialized, svg, {
      rgba: { pixels: raster.pixels, width: raster.width, height: raster.height },
      reachable: target => target === state.reservationUrl && (state.reservationVerified ?? true) ? true : undefined
    });
    const svgAsset = store.saveAsset(svg, 'image/svg+xml');
    const pngAsset = store.saveAsset(raster.asPng(), 'image/png');
    const assetHashes = sceneAssetHashes(authored);
    const visual = authored.elements.find(element => element.id === 'visual');
    if (runId) recordTools(tx, { runId, role: 'yi', versionId }, [
      toolResult('render_svg', { layerIds: authored.elements.map(layer => layer.id), assetHashes }, { sha256: svgAsset.hash }, svgAt, 'ok', pngAt),
      toolResult('render_png', { svgSha256: svgAsset.hash }, { sha256: pngAsset.hash, width: raster.width, height: raster.height }, pngAt, 'ok', pngDone)
    ]);
    return {
      scene: authored, qr, hash: svgAsset.hash, pngHash: pngAsset.hash, assetHashes,
      uploadHash: visual?.image?.startsWith('studio-asset:') ? visual.image.slice(13) : null
    };
  }

  function createVersion(tx, scene, {
    label, parent = null, diff = [], restoredFromId = null, jobId = null, source = null,
    select = true, causeCommandId = null, prepared = null
  }) {
    const { state } = tx;
    const id = `V${String(state.versions.length + 1).padStart(2, '0')}`;
    const { scene: authored, qr, hash, pngHash, assetHashes, uploadHash } = prepared ?? renderProjectPoster(tx, scene, { runId: jobId, versionId: id });
    const checkAt = Date.now();
    const review = comparisonReview(reviewScene(authored, { qr }), parent, state.versions);
    const checkDone = Date.now();
    const elementIds = diff.map(item => item.id);
    const issues = buildIssues(review, parent?.issues ?? [], elementIds);
    const version = {
      id, parentId: parent?.id ?? null, label, createdAt: Date.now(), scene: authored, diff,
      restoredFromId, jobId, source, review, issues, qr, hash, pngHash, uploadHash, assetHashes
    };
    for (const role of CLIENTS) recordTools(tx, { runId: `${id}-scores`, role, versionId: id }, [
      toolResult('reviewScene', { versionId: id, role, layerIds: authored.elements.map(layer => layer.id) }, review[role], checkAt, 'ok', checkDone)
    ]);
    state.versions.push(version);
    if (select) {
      state.selectedVersionId = id;
      state.issues = issues;
    }
    tx.emit('version', { version: versionView(version) }, { versionId: id, commandId: causeCommandId });
    return version;
  }

  function prepareDraft(tx, scene, base, { label, jobId = null, restoredFromId = null, source = null, runId = jobId, handoff } = {}) {
    const { state } = tx;
    const previous = draftForVersion(state, base);
    const id = randomUUID();
    const baseVersionId = base?.id ?? null;
    const rendered = renderProjectPoster(tx, scene, { runId, versionId: baseVersionId });
    const messageIds = [...new Set([...(previous?.source?.messageIds ?? []), ...(source?.messageIds ?? [])])];
    const updatedAt = Date.now();
    return {
      ...rendered, id, baseVersionId, label, updatedAt, iteration: (previous?.iteration ?? 0) + 1,
      jobId, handoff: designerSpeech(handoff ?? previous?.handoff), restoredFromId: restoredFromId ?? previous?.restoredFromId ?? null,
      source: { ...previous?.source, ...source, messageIds }, diff: base ? sceneDifference(base.scene, rendered.scene) : []
    };
  }

  function stageDraft(tx, scene, base, options) {
    const draft = prepareDraft(tx, scene, base, options);
    tx.state.draft = draft;
    tx.emit('draft-updated', { draft: draftView(draft, tx.state.id) }, { role: 'yi', versionId: draft.baseVersionId });
    return draft;
  }

  function commitDraftVersion(tx, draft, base, commandId) {
    const at = Date.now();
    const version = createVersion(tx, draft.scene, { prepared: draft, label: draft.label, parent: base,
      diff: draft.diff, restoredFromId: draft.restoredFromId, jobId: draft.jobId, source: draft.source, causeCommandId: commandId });
    tx.state.draft = null;
    recordTools(tx, { runId: draft.jobId ?? commandId, role: 'yi', versionId: version.id }, [
      toolResult('commit_version', { draftId: draft.id, baseVersionId: draft.baseVersionId, iteration: draft.iteration },
        { versionId: version.id, sha256: version.hash }, at)
    ]);
    return version;
  }

  function hydrateScene(scene) {
    // Asset references live in the same structured fields as the former raster data URLs.
    return JSON.parse(JSON.stringify(scene), (_, value) => {
      if (typeof value !== 'string' || !/^studio-asset:[a-f0-9]{64}$/.test(value)) return value;
      const hash = value.slice(13);
      const asset = store.asset(hash);
      const bytes = store.readAsset(hash, { verify: true });
      if (!asset || !bytes) throw new Error('上传的原始图片丢失');
      return `data:${asset.mime};base64,${Buffer.from(bytes).toString('base64')}`;
    });
  }

  function reviewVersion(tx, version, commandId, options) {
    tx.emit('review', { review: version.review, issues: version.issues }, { versionId: version.id, commandId });
    beginRound(tx, version, 'review', commandId, options);
  }

  function beginRound(tx, version, phase, commandId, { handoff = '' } = {}) {
    const { state } = tx;
    const notice = roleLanguage(state.language) === 'en' ? `${version.id} is ready for your review.` : `${version.id} 已发布，请评审。`;
    const priorVersionId = state.versions.at(-2)?.id;
    const priorRound = priorVersionId && state.reviewRounds?.findLast(item => item.versionId === priorVersionId);
    const managerFeedback = (priorRound?.managerFeedback ?? []).flatMap(({ messageId, text }) => {
      const message = state.messages.find(item => item.id === messageId);
      return message ? [{ role: message.role, versionId: priorVersionId, originalText: message.text, text }] : [];
    });
    const round = makeReviewRound(version.id, phase, CLIENTS.map(role => ({ role })), commandId,
      roundSnapshot(version, projectContext(state), { notice, designerSpeech: handoff, managerFeedback }), state.meetingMode !== false);
    state.reviewRounds ??= [];
    state.reviewRounds.push(round);
    tx.emit('round-started', { round: reviewRoundView(round) }, { versionId: version.id, commandId });
  }

  function projectContext(state) {
    return { topic: state.theme.name, brief: state.theme.brief, facts: state.theme.facts };
  }

  function rememberRole(state, role, line, version) {
    const memory = textOf(line.memory, 300);
    if (!memory || !CLIENTS.includes(role)) return;
    state.agentMemory ??= {};
    const previous = state.agentMemory[role] ?? [];
    if (previous.at(-1)?.text === memory) return;
    state.agentMemory[role] = [...previous, { versionId: version, text: memory }].slice(-16);
  }

  function clearLegacyQuestions(tx) {
    const { state } = tx;
    const count = (state.pendingQuestions?.length ?? 0) + Number(Boolean(state.pendingTurn));
    if (!count) return;
    state.pendingTurn = null;
    state.pendingQuestions = [];
    tx.emit('role-queue-cleared', { count });
  }

  function pendingWork(state) {
    if (state.job?.status === 'planning' && (state.job.planClaim?.expiresAt ?? 0) <= Date.now()) return true;
    if (state.pendingTurn || state.pendingQuestions?.length) return true;
    if (readyMeetingAssignment(state) || readyDesignerGuidance(state)) return true;
    const round = pendingRound(state);
    return Boolean(round && nextRoundSlot(round));
  }

  function syncDialogue(state) {
    if (closed || speaking.has(state.id) || !pendingWork(state)) return;
    const controller = new AbortController();
    speaking.set(state.id, controller);
    queueMicrotask(async () => {
      try {
        await runPending(state.id, controller.signal, onMeetingChunk, onDesignerSpeech);
      } catch (error) {
        if (!closed && !controller.signal.aborted) console.error('评审会话保存失败', error.message);
      } finally {
        speaking.delete(state.id);
        if (!closed) syncDialogue(store.require(state.id));
      }
    });
  }

  function claimWork(id) {
    const change = store.change(id, null, state => {
      const job = state.job;
      const designerReady = job?.status === 'planning' && (job.planClaim?.expiresAt ?? 0) <= Date.now();
      const round = pendingRound(state);
      const assignment = readyMeetingAssignment(state);
      const tx = transaction(state, designerReady ? job.commandId : (assignment ?? round)?.commandId);
      clearLegacyQuestions(tx);
      if (designerReady) {
        const initial = job.initial === true;
        const base = initial ? null : findVersion(state, job.baseVersionId);
        const draft = job.baseDraftId ? state.draft : null;
        if (job.baseDraftId && draft?.id !== job.baseDraftId) {
          failJob(tx, job, agentError('draft-changed'));
          return tx.finish(null);
        }
        const ticket = randomUUID();
        const image = getImageConfig();
        const imageKey = image?.mode === 'amd' && image.key ? image.key : null;
        job.planClaim = { ticket, expiresAt: Date.now() + (imageKey ? amdDesignerTimeoutMs + 20_000 : 105_000) };
        if (initial) job.progress = Math.max(job.progress, 20);
        tx.emit('designer-started', { jobId: job.id, ...(initial ? { initial, job: jobView(job) } : {}) }, { role: 'yi', versionId: job.baseVersionId });
        const materials = state.materials ?? [];
        const sources = initial || job.meetingRoundId ? [] : resolveSources(state, job.requestedSources ?? job.sourceIds);
        const common = { type: 'designer', ticket, jobId: job.id, commandId: job.commandId, materials, imageKey,
          history: state.designerMemory ?? [],
          context: { sourceMessages: sources.map(message => ({ id: message.id, role: message.role, requirements: requirementList(message) })),
            requestedMaterialIds: materials.filter(material => job.requestedMaterials?.includes(material.id)).map(material => material.id),
            ...(imageKey && job.imageGenerations?.length && { imageGenerations: imageGenerationContext(job) }),
            ...(job.previousError && { previousError: job.previousError }),
          },
          project: projectContext(state), language: roleLanguage(state.language),
          reservationUrl: state.reservationUrl, reservationVerified: state.reservationVerified };
        if (initial) return tx.finish({ ...common, initial, versionId: 'V01', theme: state.theme,
          scene: draft?.scene, draftId: draft?.id, text: job.operation ?? job.text });
        return tx.finish({ ...common, versionId: base.id, scene: draft?.scene ?? base.scene, draftId: draft?.id,
          text: job.operation ?? job.text });
      }
      if (assignment) {
        startMeetingAssignment(tx, assignment);
        return tx.finish(null);
      }
      if (readyDesignerGuidance(state)) {
        startGuidedAssignment(tx);
        return tx.finish(null);
      }
      if (round) {
        const slot = nextRoundSlot(round);
        if (!slot) return tx.finish(null);
        const version = findVersion(state, round.versionId);
        round.snapshot ??= roundSnapshot(version, projectContext(state));
        round.meetingMode ??= state.meetingMode !== false;
        round.imageReads ??= {};
        const ticket = randomUUID();
        const imageHash = round.snapshot.pngHash;
        round.status = 'running';
        round.active = { ticket, slot, expiresAt: Date.now() + 45000 };
        if (imageHash && !round.imageReads[slot.role]) round.imageReads[slot.role] = 'requested';
        const previous = slot.replyTo && round.messageIds.includes(slot.replyTo) ? state.messages.find(message => message.id === slot.replyTo) : null;
        const language = roleLanguage(state.language);
        tx.emit('round-turn-started', { roundId: round.id, turnId: ticket, replyTo: slot.replyTo, pngRequested: Boolean(imageHash), pngHash: imageHash }, { role: slot.role, versionId: version.id });
        return tx.finish({
          type: 'round', roundId: round.id, runId: `${round.id}-${round.turnCount + 1}`, ticket, slot, imageHash, meetingMode: round.meetingMode,
          versionId: version.id, phase: slot.rebuttal || previous ? 'rebuttal' : round.phase,
          language, previous, context: contextFor(state, slot.role, version, round), project: round.snapshot.project ?? projectContext(state)
        });
      }
      return tx.finish(null);
    });
    publishChange(change);
    return change.result;
  }

  async function readRoundImage(id, task, onTrace) {
    const key = roundImageKey(id, task);
    const at = Date.now();
    const cached = roundImages.get(key);
    if (cached?.expiresAt > at) return cached.data;
    if (cached) roundImages.delete(key);

    const input = { roundId: task.roundId, versionId: task.versionId, sha256: task.imageHash };
    let size = 0;
    try {
      const asset = await store.readAsset(task.imageHash);
      const bytes = Buffer.isBuffer(asset) ? asset : Buffer.from(asset ?? []);
      size = bytes.byteLength;
      if (!bytes.subarray(0, 8).equals(pngSignature) || createHash('sha256').update(bytes).digest('hex') !== task.imageHash) {
        throw new Error('已确认海报的 PNG 截图缺失或损坏。');
      }
      const data = `data:image/png;base64,${bytes.toString('base64')}`;
      cacheRoundImage(key, data);
      onTrace(toolResult('read_poster_png', input, { mime: 'image/png', bytes: size }, at));
      return data;
    } catch (error) {
      onTrace(toolResult('read_poster_png', input, { mime: 'image/png', bytes: size }, at, 'error'));
      throw error;
    }
  }

  async function releaseRoundClaim(id, task) {
    if (closed) return;
    await commitPending(id, state => {
      const round = state.reviewRounds?.find(item => item.id === task.roundId);
      const tx = transaction(state, round?.commandId);
      if (round?.active?.ticket !== task.ticket) return tx.finish();
      round.next = round.active.slot;
      round.active = null;
      tx.emit('round-turn-released', { roundId: round.id }, { role: task.slot.role, versionId: round.versionId });
      return tx.finish();
    });
  }

  async function runPending(id, signal, emitChunk, emitSpeech) {
    const task = claimWork(id);
    await store.flush?.();
    if (!task) return;
    if (task.type === 'designer') {
      return task.initial ? runInitialDesigner(id, task, signal, emitSpeech) : runDesigner(id, task, signal, emitSpeech);
    }
    const traces = [];
    const onTrace = entry => traces.push(entry);
    let answer, failure;
    let sentImage = false;
    try {
      const role = task.slot.role;
      let model;
      try { model = getDialogueModel(); }
      catch (error) { throw agentError('unconfigured', error.message); }
      if (typeof (task.meetingMode ? model?.meetingTurn : model?.roundTurn) !== 'function') throw agentError('unconfigured');
      if (!task.imageHash) throw agentError('poster-image', '确认稿缺少 PNG 截图。');
      let imageDataUrl;
      try { imageDataUrl = await readRoundImage(id, task, onTrace); }
      catch (error) { throw agentError('poster-image', error.message); }
      signal?.throwIfAborted();
      sentImage = Boolean(imageDataUrl);
      const input = { role, line: { role, language: task.language }, phase: task.phase,
        project: task.project, version: task.versionId, context: task.context, replyTo: task.previous, imageDataUrl, imageHash: task.imageHash,
        sessionId: id, roundId: task.roundId, language: task.language, onTrace };
      if (task.meetingMode) {
        let nextIndex = 0;
        answer = await model.meetingTurn(input, signal, async ({ index, text }) => {
          if (closed || signal?.aborted || index !== nextIndex || !textOf(text)) return;
          nextIndex++;
          await emitChunk?.({ sessionId: id, roundId: task.roundId, versionId: task.versionId, role,
            turnId: task.ticket, chunkId: `${task.ticket}:${index}`, index, text });
        });
      } else answer = await model.roundTurn(input, signal);
      if (answer?.role !== role || answer.mode !== 'online' ||
          (!(task.meetingMode && answer.skipped === true) && !textOf(answer.speech ?? answer.text))) throw agentError('empty-output');
    } catch (error) {
      if (signal?.aborted) return releaseRoundClaim(id, task);
      failure = error;
    }
    if (closed) return;
    if (signal?.aborted) return releaseRoundClaim(id, task);

    const applyAnswer = state => {
      const round = state.reviewRounds?.find(item => item.id === task.roundId);
      const tx = transaction(state, round?.commandId);
      if (round?.active?.ticket !== task.ticket) return tx.finish();
      const role = task.slot.role;
      const scope = { role, versionId: round.versionId, runId: task.runId };
      if (failure) {
        const { message, code } = agentFailure(failure, state.language);
        if (task.imageHash && round.imageReads[role] !== 'completed') round.imageReads[role] = 'unavailable';
        round.active = null;
        round.next = task.slot;
        round.status = 'failed';
        round.error = { role, message, code };
        tx.emit('round-review-failed', { roundId: round.id, role, error: message, code, round: reviewRoundView(round) }, scope);
        recordTools(tx, scope, [...traces, toolResult('review_agent', { phase: task.phase, role }, { code, error: failure.message }, Date.now(), 'error')]);
        return tx.finish();
      }
      if (sentImage) round.imageReads[role] = 'completed';
      const skipped = task.meetingMode && answer.skipped === true;
      const transcript = task.meetingMode ? task.context.meeting?.turns : task.context.peerTurns;
      const replyTo = typeof answer.replyTo === 'string' && transcript?.some(turn => turn.id === answer.replyTo && turn.role !== role)
        ? answer.replyTo : task.slot.replyTo;
      let message;
      if (skipped) {
        tx.emit('round-turn-passed', { roundId: round.id, turnId: task.ticket }, scope);
      } else {
        const line = { ...answer, role, replyTo, ...(task.meetingMode && { turnId: task.ticket, requirement: null, requirements: [] }) };
        [message] = dialogue(tx, [line], {
          kind: task.phase, versionId: round.versionId, auto: round.versionId === state.selectedVersionId,
          commandId: round.commandId, roundId: round.id
        });
        if (!task.meetingMode) rememberRole(state, role, answer, round.versionId);
      }
      const routedAt = Date.now();
      recordRoundTurn(round, message, task.slot, answer.challengeRole, { meeting: task.meetingMode, skipped });
      recordTools(tx, scope, [
        ...traces,
        toolResult('recordRoundTurn', {
          role, phase: task.phase, replyTo, challengeRole: answer.challengeRole
        }, { ...(skipped ? { skipped } : { messageId: message.id, text: message.text, requirements: message.requirements }),
          next: round.next, status: round.status }, routedAt)
      ]);
      if (state.selectedVersionId === round.versionId) {
        state.lastDialogue = state.messages.filter(line => line.roundId === round.id && line.kind !== 'answer');
      }
      if (round.status === 'completed') {
        const review = pendingMeetingReview(state);
        tx.emit('round-completed', { round: reviewRoundView(round, null, review?.round === round ? review : null) }, { versionId: round.versionId });
      }
      return tx.finish();
    };
    const change = await commitPending(id, applyAnswer);
    if (task.imageHash && change.state.reviewRounds?.find(round => round.id === task.roundId)?.status === 'completed') {
      roundImages.delete(roundImageKey(id, task));
    }
  }

  async function commitPending(id, update) {
    const change = store.commitTurn ? await store.commitTurn(update) : store.change(id, null, update);
    publishChange(change);
    return change;
  }

  async function updateDesignTask(id, task, update, { matchClaim = true } = {}) {
    const change = await commitPending(id, state => {
      const tx = transaction(state, task.commandId);
      const job = state.job;
      if (job?.id !== task.jobId || (matchClaim && job.planClaim?.ticket !== task.ticket)) {
        if (!matchClaim) return tx.finish();
        throw agentError('draft-changed');
      }
      const result = update(job, state, (type, data) => tx.emit(type, data, { role: 'yi', versionId: task.versionId }));
      return tx.finish(result);
    });
    return change.result;
  }

  function takeDesignerGuidance(id, task) {
    return updateDesignTask(id, task, (_job, state, emit) => {
      const queued = pendingGuidance(state, task.ticket);
      if (!queued.length) return [];
      const rush = queued.find(item => item.kind === 'rush');
      const selected = queued.filter(item => item.kind !== 'rush' || item === rush);
      if (rush) {
        state.designerGuidance = state.designerGuidance.filter(item => item.kind !== 'rush' || item === rush || item.ticket === task.ticket);
      }
      for (const item of selected) item.ticket = task.ticket;
      emit('designer-guidance-delivered', { jobId: task.jobId, messageIds: selected.map(item => item.id) });
      return selected.map(({ id, kind, text }) => ({ id, kind, text }));
    });
  }

  function rememberDesigner(state, memory) {
    if (!memory) return;
    (state.designerMemory ??= []).push(memory);
    const delivered = new Set((memory.guidance ?? []).map(item => item.id));
    if (delivered.size) state.designerGuidance = (state.designerGuidance ?? []).filter(item => !delivered.has(item.id));
  }

  function recordDesignerProgress(tx, task, progress) {
    if (!progress.length) return;
    const speech = progress.join(' ');
    const versionId = task.initial ? tx.state.selectedVersionId : task.versionId;
    dialogue(tx, [{ role: 'yi', turnId: task.ticket, mood: 'focused', mode: 'online', text: speech, speech }],
      { kind: 'designer-progress', versionId, commandId: task.commandId });
  }

  async function planOnlineDesign(id, task, scene, text, traces, signal, progress, emitSpeech) {
    signal?.throwIfAborted();
    let designer;
    try { designer = getDesignerModel(); }
    catch (error) { throw agentError('unconfigured', error.message); }
    if (!designer) throw agentError('unconfigured');
    const { initial, versionId, draftId, project, context, history, language } = task;
    const materials = [...task.materials];
    const allowed = new Set([...sceneAssetHashes(scene), ...materials.map(material => material.hash)]);
    const generate = task.imageKey && createDesignerImageGenerator({ key: task.imageKey, store,
      mutate: (update, options) => updateDesignTask(id, task, update, options) });
    async function validateDraft(candidate) {
      signal?.throwIfAborted();
      if (initial) checkFirstDraftFacts(candidate, project.facts);
      for (const hash of sceneAssetHashes(candidate)) {
        if (!allowed.has(hash) || (!store.asset(hash) && !await store.readAsset(hash))) throw agentError('asset-unavailable', '当前工作稿的素材无法读取。');
      }
      await initializePoster?.();
      signal?.throwIfAborted();
      const materialized = hydrateScene(candidate);
      const svg = posterSVG(materialized);
      const raster = rasterizePoster(svg);
      const { width, height } = raster;
      if (width !== candidate.width || height !== candidate.height) throw agentError('render-error', '海报尺寸与画布不一致。');
      const png = Buffer.from(raster.asPng());
      const qr = verifyPosterQR(materialized, svg, {
        rgba: { pixels: raster.pixels, width, height },
        reachable: target => target === task.reservationUrl && (task.reservationVerified ?? true) ? true : undefined,
      });
      return { imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
        imageHash: createHash('sha256').update(png).digest('hex'), width, height, qr };
    }
    const plan = await designer({ initial, sessionId: id, versionId, draftId, scene, materials, text, project, context, history, language }, {
      signal, validateDraft, onTrace: entry => traces.push(entry),
      takeGuidance: () => takeDesignerGuidance(id, task),
      async onSpeech({ text, index }) {
        const speech = designerSpeech(text);
        if (closed || signal?.aborted || index !== progress.length || !speech) return;
        await emitSpeech?.({ sessionId: id, jobId: task.jobId, versionId, turnId: task.ticket,
          chunkId: `${task.ticket}:${index}`, index, text: speech, role: 'yi' });
        progress.push(speech);
      },
      ...(generate && { async generateImage(args, signal, artwork) {
        const material = await generate(args, signal, artwork);
        allowed.add(material.hash);
        if (!materials.some(item => item.id === material.id)) materials.push(material);
        return { materialId: material.id, name: material.name, width: material.width, height: material.height };
      } }),
    });
    if (!plan?.patches?.length) throw agentError('empty-output', plan?.clarification);
    const changed = applyPatch(scene, plan.patches);
    if (!changed.diff.length) throw agentError('empty-output');
    if (sceneAssetHashes(changed.scene).some(hash => !allowed.has(hash))) throw agentError('asset-unavailable');
    return { plan, changed };
  }

  function failJob(tx, job, error) {
    const { code, message } = agentFailure(error, tx.state.language);
    delete job.planClaim;
    Object.assign(job, { status: 'failed', error: message, errorCode: code, dueAt: null });
    tx.emit('tool-failed', { job: jobView(job), error: message, code }, { role: 'yi', versionId: job.baseVersionId });
  }

  async function runInitialDesigner(id, task, signal, emitSpeech) {
    let scene, reply, memory, failure;
    const traces = [];
    const progress = [];
    const { theme: project, reservationUrl, language } = task;
    const started = Date.now();
    try {
      const base = task.scene ?? createInitialPoster(project, { reservationUrl, language });
      const { plan, changed } = await planOnlineDesign(id, task, base, task.text, traces, signal, progress, emitSpeech);
      checkFirstDraftFacts(changed.scene, project.facts);
      for (const hash of sceneAssetHashes(changed.scene)) {
        if (!store.asset(hash) && !await store.readAsset(hash)) throw agentError('asset-unavailable');
      }
      try { await initializePoster?.(); }
      catch (error) { throw agentError('render-error', error.message); }
      scene = changed.scene;
      reply = plan.reply;
      memory = plan.memory;
      traces.push(toolResult('apply_initial_poster', { versionId: task.versionId, operations: plan.patches }, { diff: changed.diff }, started));
    } catch (error) {
      failure = error;
      if (!signal?.aborted) traces.push(toolResult('create_initial_poster', { versionId: task.versionId }, { error: error.message }, started, 'error'));
    }

    if (closed) return;
    await commitPending(id, state => {
      const tx = transaction(state, task.commandId);
      const job = state.job;
      if (job?.id !== task.jobId || !job.initial || job.planClaim?.ticket !== task.ticket || state.versions.length) return tx.finish();
      delete job.planClaim;
      if (signal?.aborted) {
        tx.emit('designer-released', { jobId: job.id, initial: true }, { role: 'yi' });
        return tx.finish();
      }

      const scope = { runId: job.id, role: 'yi', versionId: task.versionId };
      recordTools(tx, scope, traces);
      recordDesignerProgress(tx, task, progress);
      if (failure) {
        failJob(tx, job, failure);
        return tx.finish();
      }

      const at = Date.now();
      let draft;
      try {
        draft = stageDraft(tx, scene, null, { label: firstDraftLabel[roleLanguage(state.language)], jobId: job.id, handoff: reply });
      } catch (error) {
        recordTools(tx, scope, [toolResult('render_initial_poster', { versionId: task.versionId }, { error: error.message }, at, 'error')]);
        failJob(tx, job, agentError('render-error'));
        return tx.finish();
      }
      rememberDesigner(state, memory);
      Object.assign(job, { status: 'awaitingApproval', progress: 100, draftId: draft.id, versionId: null, error: null, errorCode: null });
      tx.emit('job-awaiting-approval', { job: jobView(job), diff: draft.diff }, { role: 'yi' });
      employeeReply(tx, reply, ['title', 'visual', 'info'], null);
      return tx.finish();
    });
  }

  async function runDesigner(id, task, signal, emitSpeech) {
    const traces = [];
    const progress = [];
    let plan, failure;
    const at = Date.now();
    try {
      ({ plan } = await planOnlineDesign(id, task, task.scene, task.text, traces, signal, progress, emitSpeech));
    } catch (error) {
      failure = error;
      if (!signal?.aborted) traces.push(toolResult('plan_revision', { jobId: task.jobId }, { error: error.message }, at, 'error'));
    }
    if (closed) return;
    await commitPending(id, state => {
      const tx = transaction(state, task.commandId);
      const job = state.job;
      if (job?.id !== task.jobId || job.planClaim?.ticket !== task.ticket) return tx.finish();
      const meta = { role: 'yi', versionId: job.baseVersionId };
      delete job.planClaim;
      if (signal?.aborted) {
        tx.emit('designer-released', { jobId: job.id }, meta);
        return tx.finish();
      }
      recordTools(tx, { ...meta, runId: job.id }, traces);
      recordDesignerProgress(tx, task, progress);
      if (failure) {
        failJob(tx, job, failure);
        return tx.finish();
      }
      Object.assign(job, {
        status: 'working', agentPlanned: true, label: plan.label || job.label, patches: plan.patches, reply: plan.reply,
        elementIds: plan.elementIds ?? [], dueAt: Date.now() + jobDelay(job), designMemory: plan.memory, guidanceTicket: task.ticket
      });
      delete job.fallbackPlan;
      tx.emit('designer-ready', { job: jobView(job), patches: job.patches }, meta);
      return tx.finish();
    });
  }

  function publishChange(change) {
    const update = { ...change, state: publicState(change.state) };
    if (!change.duplicate && change.events.length) publish(update);
    if (autoSchedule) {
      syncClock(change.state);
      syncDialogue(change.state);
    }
    return update;
  }

  function syncClock(state) {
    const job = state.job;
    const previous = clocks.get(state.id);
    if (timedJob(job) && previous?.dueAt === job.dueAt && previous?.jobId === job.id) return;
    if (previous) clearTimeout(previous.timer);
    clocks.delete(state.id);
    if (closed || !timedJob(job)) return;
    const timer = setTimeout(() => {
      clocks.delete(state.id);
      try {
        tick(state.id, job.id);
      } catch (error) {
        console.error('工单计时失败', error.message);
        const current = store.read(state.id);
        if (current?.job?.id === job.id && timedJob(current.job)) {
          current.job.dueAt = Date.now() + 1000;
          syncClock(current);
        }
      }
    }, Math.max(0, job.dueAt - Date.now()));
    clocks.set(state.id, { timer, dueAt: job.dueAt, jobId: job.id });
  }

  const jobDelay = job => job.rushed ? Math.max(65, Math.floor(stepMs * .55)) : stepMs;

  function tick(id, jobId) {
    const change = store.change(id, null, state => {
      const job = state.job;
      const tx = transaction(state, job?.commandId);
      if (job?.id !== jobId || !timedJob(job)) return tx.finish();
      const meta = { role: 'yi', versionId: job.baseVersionId };
      if (!job.agentPlanned) {
        requeueDesignJob(job);
        tx.emit('job-requeued', { job: jobView(job) }, meta);
        return tx.finish();
      }
      if (job.status === 'paused') {
        job.status = 'working';
        job.autoResume = false;
        job.dueAt = Date.now() + jobDelay(job);
        tx.emit('job-resumed', { job: jobView(job), source: 'easter-egg' }, meta);
        return tx.finish();
      }
      const before = job.progress;
      job.progress = Math.min(100, job.progress + (job.rushed ? 20 : 10));
      if (!job.pausedOnce && job.slackAt > before && job.slackAt <= job.progress) {
        job.pausedOnce = true;
        job.status = 'paused';
        job.autoResume = true;
        job.dueAt = Date.now() + 950;
        tx.emit('job-paused', { job: jobView(job), source: 'easter-egg' }, meta);
      } else if (job.progress < 100) {
        job.dueAt = Date.now() + jobDelay(job);
        tx.emit('job-progress', { job: jobView(job) }, meta);
      } else {
        finishJob(tx, job);
      }
      return tx.finish();
    });
    publishChange(change);
  }

  function finishJob(tx, job) {
    const { state } = tx;
    const base = findVersion(state, job.baseVersionId);
    const meta = { role: 'yi', versionId: base.id };
    const scope = { ...meta, runId: job.id };
    tx.emit('tool-call', { jobId: job.id, baseVersionId: base.id, patches: job.patches }, meta);
    const automatic = Boolean((job.meetingRoundId || job.autoPublish) && state.meetingApprovalRequired !== true);
    let draft, diff, version;
    const at = Date.now();
    let tool = 'applyPatch';
    try {
      const previous = job.baseDraftId ? draftForVersion(state, base) : null;
      if (job.baseDraftId && previous?.id !== job.baseDraftId) throw agentError('draft-changed');
      const changed = applyPatch(previous?.scene ?? base.scene, job.patches);
      diff = changed.diff;
      if (!diff.length) throw agentError('empty-output');
      recordTools(tx, scope, [toolResult('applyPatch', { baseVersionId: base.id, operations: job.patches }, { diff }, at)]);
      tool = 'stageDraft';
      const options = { label: job.label, jobId: job.id, handoff: job.reply, source: { text: job.text, messageIds: job.sourceIds,
        ...(job.meetingRoundId && { meetingRoundId: job.meetingRoundId }) } };
      if (automatic) {
        draft = prepareDraft(tx, changed.scene, base, options);
        tool = 'commit_version';
        version = commitDraftVersion(tx, draft, base, job.commandId);
      } else draft = stageDraft(tx, changed.scene, base, options);
    } catch (error) {
      recordTools(tx, scope, [toolResult(tool, { baseVersionId: base.id, operations: job.patches }, { error: error.message }, at, 'error')]);
      job.progress = 90;
      failJob(tx, job, tool === 'applyPatch' ? error : agentError('render-error', error.message));
      return;
    }
    markAssigned(state, resolveSources(state, job.requestedSources ?? job.sourceIds));
    rememberDesigner(state, job.designMemory);
    delete job.designMemory;
    delete job.guidanceTicket;
    job.dueAt = null;
    if (version) {
      Object.assign(job, { status: 'completed', draftId: null, versionId: version.id });
      tx.emit('job-completed', { job: jobView(job), diff: version.diff, automatic: true }, { role: 'yi', versionId: version.id });
      employeeReply(tx, job.reply, job.elementIds, version.id);
      reviewVersion(tx, version, job.commandId, { handoff: job.reply });
    } else {
      Object.assign(job, { status: 'awaitingApproval', draftId: draft.id, versionId: null });
      tx.emit('job-awaiting-approval', { job: jobView(job), diff }, meta);
      employeeReply(tx, job.reply, job.elementIds, base.id);
    }
  }

  async function newSession(project, reservationUrl, reservationVerified, requestedLanguage) {
    const startedAt = Date.now();
    const state = {
      id: randomUUID(), theme: project, language: roleLanguage(requestedLanguage ?? 'en'), startedAt, lastAt: startedAt, reservationUrl, reservationVerified, seq: 0, appearance: 'manga-2',
      selectedRole: 'zhou', selectedVersionId: null, meetingMode: true, meetingApprovalRequired: false, nextJob: 1, job: null, slaps: 0,
      messages: [], requirements: [], versions: [], issues: [], lastDialogue: [], deliveries: [],
      reviewRounds: [], agentMemory: {}, designerMemory: [], designerGuidance: [], materials: [], toolTraces: [], draft: null,
      finalizedVersionId: null, mode: 'online'
    };
    const tx = transaction(state);
    tx.emit('session-start', { themeId: project.id, topic: project.name, mode: state.mode });
    const number = state.nextJob++;
    state.job = {
      id: `J${String(number).padStart(2, '0')}`, number, initial: true, label: firstDraftLabel[state.language],
      status: 'planning', progress: 0, baseVersionId: null, versionId: null, attempts: 1,
      dueAt: null, text: [project.name, project.brief].filter(Boolean).join('\n'), elementIds: [], sourceIds: [],
    };
    tx.emit('job-started', { job: jobView(state.job) }, { role: 'yi' });
    const { events, snapshot } = tx.finish();
    store.create(state, events, snapshot);
    if (autoSchedule) syncDialogue(state);
    return publicState(state);
  }

  function meetingAssignmentInput(state, turns) {
    const names = roleLanguage(state.language) === 'en'
      ? { zhou: 'Director Zhou', lin: 'Lin Chi', tang: 'A-Tang' }
      : { zhou: '周总', lin: '林尺', tang: '阿唐' };
    return {
      text: turns.map(turn => `${names[turn.role]}\n${turn.text}`).join('\n\n'),
      sourceIds: turns.map(turn => turn.id),
    };
  }

  function startMeetingAssignment(tx, round) {
    const input = meetingAssignmentInput(tx.state, pendingMeetingAssignment(tx.state).feedback);
    const baseVersionId = round.versionId;
    const { jobId } = startJob(tx, { ...input, source: 'meeting', baseVersionId }, round.commandId, round);
    round.assignmentPending = false;
    round.assignmentJobId = jobId;
    round.managerRequestedAssignment = false;
    tx.emit('meeting-assignment-started', { roundId: round.id, jobId, sourceIds: input.sourceIds }, { role: 'yi', versionId: baseVersionId });
  }

  function releaseMeetingAssignment(tx, roundId) {
    const { state } = tx;
    const round = pendingMeetingAssignment(state)?.round;
    if (!round || round.id !== roundId) {
      throw httpError(409, roleLanguage(state.language) === 'en'
        ? 'There is no unassigned feedback for the latest version.' : '最新版本没有待放行的评审意见。');
    }
    if (!round.managerRequestedAssignment) {
      round.assignmentPending = true;
      round.managerRequestedAssignment = true;
      tx.emit('meeting-assignment-released', { roundId: round.id }, { role: 'yi', versionId: round.versionId });
    }
    return { roundId: round.id, queued: true };
  }

  function reviewMeetingFeedback(tx, { roundId, messageId, decision, text }) {
    const { state } = tx;
    const english = roleLanguage(state.language) === 'en';
    const review = pendingMeetingReview(state);
    if (state.meetingApprovalRequired !== true || !review || review.round.id !== roundId ||
        review.round.managerRequestedAssignment || !review.reviewable.some(turn => turn.id === messageId)) {
      throw httpError(409, english ? 'This remark is no longer open for approval.' : '这条甲方意见当前不在可审批范围内。');
    }
    if (decision !== 'return' && decision !== 'restore') {
      throw httpError(400, english ? 'Choose whether to return or restore the remark.' : '请选择退回或恢复这条意见。');
    }
    const { round } = review;
    const feedback = (round.managerFeedback ?? []).filter(item => item.messageId !== messageId);
    if (decision === 'return') feedback.push({ messageId, text: textOf(text), at: Date.now() });
    round.managerFeedback = feedback;
    const updated = pendingMeetingReview(state);
    const view = reviewRoundView(round, null, updated);
    tx.emit('meeting-feedback-reviewed', { messageId, decision, round: view }, { versionId: round.versionId });
    return { roundId, messageId, decision };
  }

  function queueGuidance(tx, { text, source, kind }) {
    const { state } = tx;
    const job = state.job;
    const versionId = job?.baseVersionId ?? state.selectedVersionId;
    const message = appendMessage(tx, { role: 'manager', target: 'yi', text, source },
      kind === 'rush' ? 'nudge' : 'designer-guidance', versionId);
    (state.designerGuidance ??= []).push({ id: message.id, kind, text });
    return message;
  }

  function interjectMeeting(tx, payload) {
    const { state } = tx;
    const text = textOf(payload.text, 1600);
    if (!text) throw httpError(400, '请输入要加入会议的话。');
    const message = queueGuidance(tx, { text, source: textOf(payload.source, 40) || 'voice', kind: 'voice' });
    return { messageId: message.id, deferred: !readyDesignerGuidance(state) };
  }

  function startGuidedAssignment(tx) {
    const { state } = tx;
    const first = pendingGuidance(state).find(item => item.kind !== 'rush');
    const baseVersionId = state.draft?.baseVersionId ?? state.versions.at(-1)?.id ?? null;
    const { jobId } = startJob(tx, { text: first.text, source: 'voice', baseVersionId }, null, null, true);
    tx.emit('designer-guidance-started', { jobId }, { role: 'yi', versionId: baseVersionId });
  }

  function startJob(tx, payload, commandId, meetingRound, guidanceOnly = false) {
    const { state } = tx;
    if (BUSY.has(state.job?.status)) throw httpError(409, '小乙还有一张工单在手上。');
    const base = editableVersion(state, payload.baseVersionId);
    const baseVersionId = base?.id ?? null;
    const draft = draftForVersion(state, base);
    const sources = resolveSources(state, payload.sourceIds);
    const sourceIds = meetingRound ? payload.sourceIds : [...new Set(sources.map(item => item.id))];
    const text = (meetingRound ? payload.text : textOf(payload.text, 2600)) || sources.flatMap(item => {
      if (item.kind === 'opening' && item.requirement?.stage === 'vague' && !item.pickedRequirementId) return [item.text];
      const instructions = requirementList(item).map(requirement => requirement.instruction).filter(Boolean);
      return instructions.length ? instructions : [item.text];
    }).join('。');
    if (!text) throw httpError(400, '写下要改的地方，或选一条甲方意见。');
    const forwarded = sources.flatMap(item => requirementList(item)).filter(item => item.instruction);
    const display = forwarded.map(item => {
      const projected = projectRequirement(item, state.language);
      return projected.displayInstruction || projected.text;
    }).join('\n');
    const original = sources.length === 1 && projectDialogueLine(sources[0], state.language).text === text;
    const operation = guidanceOnly ? (roleLanguage(state.language) === 'en'
      ? 'Revise the poster using the queued project manager guidance.' : '按照项目经理新加入队列的指导修改海报。')
      : meetingRound ? text : display === text || (original && sources[0].pickedRequirementId)
      ? forwarded.map(item => item.instruction).join('；') : original ? sources[0].text : text;
    const source = textOf(payload.source, 40) || 'text';
    const requestedSources = meetingRound ? sourceIds : Array.isArray(payload.sourceIds) ? payload.sourceIds.filter(id => typeof id === 'string').slice(0, 30) : [];
    const requestedMaterials = Array.isArray(payload.materialIds) ? payload.materialIds.filter(id => typeof id === 'string').slice(0, 12) : [];
    const label = roleLanguage(state.language) === 'en' ? 'Preparing the edit' : '准备改稿';
    const elementIds = [...new Set(forwarded.flatMap(item => item.elementIds ?? []))];
    const instruction = meetingRound || guidanceOnly ? null : appendMessage(tx, {
      role: 'manager', text, sourceIds, elementIds, replyTo: sourceIds[0] ?? null, source
    }, 'instruction', baseVersionId);
    const number = state.nextJob++;
    state.mode = 'online';
    state.job = {
      id: `J${String(number).padStart(2, '0')}`, number, label,
      status: 'planning', progress: 0, pausedOnce: false, baseVersionId,
      baseDraftId: draft?.id ?? null, slackAt: Math.random() < .07 ? slackProgress[Math.floor(Math.random() * slackProgress.length)] : null,
      elementIds, sourceIds, instructionId: instruction?.id ?? null, text, commandId, attempts: 1, dueAt: null,
      operation: operation || text, requestedSources, requestedMaterials,
      ...(!base && { initial: true }),
      ...(meetingRound && { meetingRoundId: meetingRound.id }),
      ...(base && guidanceOnly && state.meetingMode !== false && { autoPublish: true }),
    };
    tx.emit('job-started', { job: jobView(state.job) }, { role: 'yi', versionId: baseVersionId });
    return { jobId: state.job.id };
  }

  function resume(tx, payload, commandId) {
    const { state } = tx;
    const source = textOf(payload.source, 40) || 'button';
    const physical = !/^(text|voice|speech|microphone|chat)/i.test(source);
    const job = state.job;
    const resumed = job?.status === 'paused';
    const atWork = BUSY.has(job?.status);
    const hint = physical ? (roleLanguage(state.language) === 'en' ? 'Desk tap. Xiao Yi, please work faster.' : '拍桌催稿。小乙，加快工作。') : textOf(payload.text);
    const ticket = atWork ? job.planClaim?.ticket ?? job.guidanceTicket : undefined;
    const alreadyQueued = physical && pendingGuidance(state, ticket).some(item => item.kind === 'rush');
    const message = hint && !alreadyQueued ? queueGuidance(tx, { text: hint, source, kind: physical ? 'rush' : 'instruction' }) : null;
    if (atWork && (physical || hint)) {
      job.rushed = true;
      if (job.status === 'working') job.dueAt = Math.min(job.dueAt, Date.now() + jobDelay(job));
    }
    if (physical) {
      state.slaps++;
      tx.emit('slap', { source, durationMs: 750, jobId: job?.id ?? null, resumed, count: state.slaps }, { role: 'yi' });
      if (message) recordTools(tx, { runId: atWork ? job.id : message.id, role: 'yi', versionId: job?.baseVersionId ?? state.selectedVersionId }, [
        toolResult('prioritize_assignment', { messageId: message.id, text: hint, source, jobId: atWork ? job.id : null }, { rushed: atWork, resumed }, message.createdAt)
      ]);
    } else {
      tx.emit('nudge', { source, jobId: job?.id ?? null, resumed }, { role: 'yi' });
    }
    if (resumed) {
      job.status = 'working';
      job.autoResume = false;
      job.resumeCommandId = commandId;
      job.dueAt = Date.now() + jobDelay(job);
      tx.emit('job-resumed', { job: jobView(job), source }, { role: 'yi', versionId: job.baseVersionId });
    }
    return { resumed, jobId: job?.id ?? null, queued: Boolean(message), alreadyQueued };
  }

  function changeVersion(tx, type, payload, commandId) {
    const { state } = tx;
    const version = findVersion(state, payload.versionId);
    if (type === 'selectVersion') {
      state.selectedVersionId = version.id;
      state.issues = version.issues;
      state.lastDialogue = state.messages.filter(item => item.versionId === version.id && ['review', 'opening', 'rebuttal'].includes(item.kind));
      tx.emit('version-selected', { versionId: version.id });
      return { versionId: version.id };
    }
    if (type === 'restore') {
      if (BUSY.has(state.job?.status)) throw httpError(409, '请先让小乙做完当前工单，再恢复旧稿。');
      if (state.draft) throw httpError(409, '请先确认或放弃当前草稿，再恢复旧稿。');
      const parent = findVersion(state);
      const draft = stageDraft(tx, version.scene, parent, {
        label: `恢复 ${version.id}`, restoredFromId: version.id, runId: commandId
      });
      return { draftId: draft.id };
    }
    if (type === 'finalize') {
      state.finalizedVersionId = version.id;
      tx.emit('finalized', { versionId: version.id, hash: version.hash }, { versionId: version.id });
      return { versionId: version.id };
    }
    const format = String(payload.format ?? 'svg').toLowerCase();
    if (!['png', 'svg'].includes(format)) throw httpError(400, '请选择 PNG 或 SVG 格式。');
    const hash = format === 'png' ? version.pngHash : version.hash;
    if (!store.asset(hash, { verify: true })) throw httpError(409, '这个版本的导出文件丢失。');
    const result = {
      id: commandId, format, hash, versionId: version.id,
      url: `${posterUrl(state.id, version.id, format)}?download=1`,
      fileName: `${state.theme.name.replace(/[<>:"/\\|?*]/g, ' ')}_${version.id}.${format}`, at: Date.now(),
      review: version.review, issues: version.issues
    };
    state.deliveries.push(result);
    tx.emit('exported', { delivery: result }, { versionId: version.id });
    return result;
  }

  function changeDraft(tx, type, { draftId }, commandId) {
    const { state } = tx;
    const draft = state.draft;
    if (!draft || draft.id !== draftId) throw httpError(409, '草稿已更新，请查看最新稿。');
    if (BUSY.has(state.job?.status)) throw httpError(409, '请等小乙改完这轮草稿。');
    const job = state.job;
    const initial = draft.baseVersionId === null && !state.versions.length;
    if (type === 'discardDraft') {
      state.draft = null;
      if (initial && job?.initial) {
        Object.assign(job, { draftId: null, baseDraftId: null, text: [state.theme.name, state.theme.brief].filter(Boolean).join('\n') });
        delete job.operation;
        failJob(tx, job, agentError('draft-discarded'));
      } else if (job?.status === 'awaitingApproval') {
        job.status = 'cancelled';
        job.draftId = null;
      }
      tx.emit('draft-discarded', { draftId }, { versionId: draft.baseVersionId });
      return { draftId };
    }
    const base = initial ? null : findVersion(state, draft.baseVersionId);
    const version = commitDraftVersion(tx, draft, base, commandId);
    if (job?.status === 'awaitingApproval' || (initial && job?.initial)) {
      Object.assign(job, { status: 'completed', progress: 100, versionId: version.id, draftId: null, error: null, errorCode: null });
    }
    tx.emit('draft-approved', { draftId, versionId: version.id }, { versionId: version.id });
    const handoff = draft.handoff || (draft.jobId && job?.id === draft.jobId ? job.reply : '');
    if (initial) beginRound(tx, version, 'opening', commandId, { handoff });
    else reviewVersion(tx, version, commandId, { handoff });
    return { versionId: version.id };
  }

  function checkReservation(tx, payload, proof) {
    const { state } = tx;
    const version = findVersion(state, payload.versionId);
    const art = store.asset(version.hash, { verify: true });
    if (!art) throw httpError(409, '这版海报的原始文件缺失，暂时无法复核。');
    const reached = proof?.reservationUrl === state.reservationUrl && proof.verified;
    const qr = verifyPosterQR(version.scene, Buffer.from(store.readAsset(version.hash, { verify: true })).toString('utf8'), {
      reachable: target => reached && target === state.reservationUrl ? true : undefined
    });
    const changed = qr !== version.qr;
    if (reached) state.reservationVerified = true;
    if (changed) {
      const prior = structuredClone(version.review);
      const parent = state.versions.find(item => item.id === version.parentId);
      version.qr = qr;
      version.review = comparisonReview(reviewScene(version.scene, { qr }), parent, state.versions.filter(item => item !== version));
      const tang = version.review.tang;
      if (tang.pendingWeight && Number.isFinite(prior.tang.score) && !prior.tang.pendingWeight) {
        tang.previousScore = prior.tang.score;
        tang.referenceScore = prior.tang.score;
        tang.referenceVersionId = version.id;
      }
      version.issues = buildIssues(version.review, version.issues, ['qr']);
      if (state.selectedVersionId === version.id) state.issues = version.issues;
    }
    tx.emit('qr-checked', { qr, changed, review: version.review, issues: version.issues }, { role: 'tang', versionId: version.id });
    return { versionId: version.id, qr, changed };
  }

  function editCanvas(tx, payload, commandId) {
    const { state } = tx;
    if (BUSY.has(state.job?.status)) throw httpError(409, '请等小乙完成当前工单。');
    if (payload.versionId !== state.selectedVersionId) throw httpError(409, '当前海报版本已切换，请重新打开画布。');
    const base = editableVersion(state);
    const previous = draftForVersion(state, base);
    if ((payload.draftId ?? null) !== (previous?.id ?? null)) throw httpError(409, '草稿已更新，请重新打开画布。');
    const scope = { runId: commandId, role: 'yi', versionId: base?.id ?? null };
    const at = Date.now();
    let edit;
    try { edit = prepareCanvasEdits(previous?.scene ?? base.scene, payload.calls); }
    catch (error) { throw httpError(400, error.message); }
    recordTools(tx, scope, [...edit.traces, toolResult('applyPatch', { operations: edit.patches }, { diff: edit.diff }, at)]);
    if (!edit.diff.length) return { draftId: previous?.id ?? null };
    const label = roleLanguage(state.language) === 'en' ? 'Canvas edit' : '画布修改';
    const draft = stageDraft(tx, edit.scene, base, { label, jobId: previous?.jobId ?? null, runId: commandId });
    if (state.job?.status === 'awaitingApproval') state.job.draftId = draft.id;
    tx.emit('canvas-edited', { draftId: draft.id, diff: edit.diff }, { role: 'yi', versionId: draft.baseVersionId });
    return { draftId: draft.id };
  }

  function runCommand(tx, type, payload, commandId, proof) {
    const { state } = tx;
    switch (type) {
      case 'setMeetingMode': {
        if (typeof payload.enabled !== 'boolean') throw httpError(400, '请选择是否开启会议模式。');
        state.meetingMode = payload.enabled;
        const round = state.reviewRounds?.findLast(item => item.versionId === state.selectedVersionId);
        if (round && round.status !== 'completed' && !round.turnCount && !round.active) round.meetingMode = state.meetingMode;
        tx.emit('meeting-mode-selected', { enabled: state.meetingMode });
        return { meetingMode: state.meetingMode };
      }
      case 'setMeetingApproval': {
        if (typeof payload.required !== 'boolean') throw httpError(400, roleLanguage(state.language) === 'en'
          ? 'Choose whether meeting revisions require approval.' : '请选择会议改稿是否需要审批。');
        state.meetingApprovalRequired = payload.required;
        tx.emit('meeting-approval-selected', { required: payload.required });
        return { meetingApprovalRequired: payload.required };
      }
      case 'meetingInterject': return interjectMeeting(tx, payload);
      case 'releaseMeetingAssignment': return releaseMeetingAssignment(tx, payload.roundId);
      case 'reviewMeetingFeedback': return reviewMeetingFeedback(tx, payload);
      case 'setLanguage': {
        const language = roleLanguage(payload.language);
        if (state.language !== language) {
          state.language = language;
          tx.emit('language-selected', { language });
        }
        return { language };
      }
      case 'selectRole': {
        const role = payload.role;
        if (!CLIENTS.includes(role) && role !== 'yi') throw httpError(400, '找不到这位角色。');
        state.selectedRole = role;
        tx.emit('role-selected', { role }, { role });
        return { role };
      }
      case 'ask': throw httpError(409, roleLanguage(state.language) === 'en'
        ? 'Clients review automatically. You can forward requests to Xiao Yi.' : '甲方会自动评审，可以把需求转交小乙。');
      case 'assign': return startJob(tx, payload, commandId);
      case 'canvasEdit': return editCanvas(tx, payload, commandId);
      case 'nudge': return resume(tx, payload, commandId);
      case 'confirmDraft':
      case 'discardDraft': return changeDraft(tx, type, payload, commandId);
      case 'defer': {
        const requirement = state.requirements.find(item => item.id === payload.requirementId);
        if (!requirement) throw httpError(404, '找不到这条需求。');
        requirement.status = payload.deferred === false ? 'open' : 'deferred';
        tx.emit('requirement-status', { requirementId: requirement.id, status: requirement.status }, { role: requirement.role });
        return { requirementId: requirement.id, status: requirement.status };
      }
      case 'selectVersion':
      case 'restore':
      case 'finalize':
      case 'export': return changeVersion(tx, type, payload, commandId);
      case 'verifyReservation': return checkReservation(tx, payload, proof);
      case 'retryReview': {
        const round = state.reviewRounds?.find(item => item.id === payload.roundId);
        if (round?.status !== 'failed' || !round.next) throw httpError(409, '没有这轮待重试的评审。');
        const role = round.next.role;
        round.status = 'queued';
        round.error = null;
        state.mode = 'online';
        tx.emit('round-review-retried', { roundId: round.id, role, round: reviewRoundView(round) }, { role, versionId: round.versionId });
        return { roundId: round.id };
      }
      case 'retry': {
        const job = state.job;
        if (job?.id !== payload.jobId || job.status !== 'failed') throw httpError(409, '没有这张待重试的工单。');
        const base = job.initial ? null : findVersion(state, job.baseVersionId);
        job.baseDraftId = draftForVersion(state, base)?.id ?? null;
        requeueDesignJob(job);
        job.attempts++;
        state.mode = 'online';
        tx.emit('job-retried', { job: jobView(job) }, { role: 'yi', versionId: job.baseVersionId });
        return { jobId: job.id };
      }
      case 'importMaterial': {
        const at = Date.now();
        let image;
        try { image = verifyUploadPng(payload.data); } catch (error) { throw httpError(400, error.message); }
        if ((state.materials?.length ?? 0) >= projectMaterialLimit) throw httpError(409, '这个项目的素材库已经放满。');
        let sourceUrl;
        if (typeof payload.sourceUrl === 'string') {
          try {
            const source = new URL(payload.sourceUrl);
            if (source.protocol === 'https:' && !source.username && !source.password) sourceUrl = `${source.origin}${source.pathname}`.slice(0, 600);
          } catch { /* The original bytes remain usable. */ }
        }
        const name = textOf(payload.name, 120) || (roleLanguage(state.language) === 'en' ? 'Imported image' : '导入图片');
        const { material, added } = saveProjectMaterial(store, state, { ...image, name, sourceUrl });
        if (!added) return { materialId: material.id, name: material.name };
        recordTools(tx, { runId: commandId, role: 'yi', versionId: state.selectedVersionId }, [
          toolResult('import_material', { name, sourceUrl, mime: 'image/png' }, material, at)
        ]);
        tx.emit('material-imported', { material }, { role: 'yi' });
        return { materialId: material.id, name };
      }
      case 'upload': {
        if (BUSY.has(state.job?.status)) throw httpError(409, '请先完成手头的工单，再替换主视觉。');
        const name = textOf(payload.name, 160) || '上传图片';
        const base = editableVersion(state);
        const previous = draftForVersion(state, base);
        let upload;
        try {
          upload = applyUpload(previous?.scene ?? base.scene, payload.data, name);
        } catch (error) {
          throw httpError(400, error.message);
        }
        const { scene } = upload;
        const asset = store.saveAsset(Buffer.from(payload.data.slice(22), 'base64'), 'image/png');
        const reference = `studio-asset:${asset.hash}`;
        const referenced = JSON.parse(JSON.stringify(scene), (_, value) => value === payload.data ? reference : value);
        const draft = stageDraft(tx, referenced, base, { label: '替换主视觉', source: { name }, runId: commandId });
        if (state.job?.status === 'awaitingApproval') state.job.draftId = draft.id;
        tx.emit('uploaded', { hash: asset.hash, name, mime: asset.mime, draftId: draft.id }, { versionId: draft.baseVersionId });
        return { draftId: draft.id };
      }
      default: throw httpError(400, '无法识别这个操作。');
    }
  }

  function command(sessionId, { id, type, payload = {} } = {}, proof) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || typeof type !== 'string' || !payload || typeof payload !== 'object') {
      throw httpError(400, '操作缺少有效编号或内容。');
    }
    const change = store.change(sessionId, id, state => {
      const tx = transaction(state, id);
      try {
        return tx.finish(runCommand(tx, type, payload, id, proof));
      } catch (error) {
        if (!error.statusCode) throw error;
        tx.emit('command-rejected', { type, error: error.message });
        return tx.finish(null, error);
      }
    });
    return publishChange(change);
  }

  return {
    newSession, command,
    async advance(id, { dialogue = true, signal, onMeetingChunk: emitChunk = onMeetingChunk, onDesignerSpeech: emitSpeech = onDesignerSpeech } = {}) {
      const { job } = store.require(id);
      if (timedJob(job) && job.dueAt <= Date.now()) {
        tick(id, job.id);
        await store.flush?.();
      }
      if (dialogue && pendingWork(store.require(id))) await runPending(id, signal, emitChunk, emitSpeech);
      return publicState(store.require(id));
    },
    recover() {
      for (const state of store.list()) {
        syncClock(state);
        if (pendingRound(state)?.active || state.pendingTurn || state.pendingQuestions?.length || state.job?.planClaim) {
          store.change(state.id, null, current => {
            const tx = transaction(current);
            const round = pendingRound(current);
            clearLegacyQuestions(tx);
            if (round?.active) round.active.expiresAt = 0;
            if (current.job?.planClaim) current.job.planClaim.expiresAt = 0;
            if (round?.active || current.job?.planClaim) tx.emit('conversation-resumed', { roundId: round?.id ?? null });
            return tx.finish();
          });
        }
        syncDialogue(store.require(state.id));
      }
    },
    close() {
      closed = true;
      for (const clock of clocks.values()) clearTimeout(clock.timer);
      for (const controller of speaking.values()) controller.abort();
      clocks.clear();
      speaking.clear();
    }
  };
}
