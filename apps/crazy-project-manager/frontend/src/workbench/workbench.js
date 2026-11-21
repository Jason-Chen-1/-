import { language, t, withLanguage } from '../i18n.js';
import { getAudioPreferences, setAudioPreference, subscribeAudioPreferences } from '../audio-preferences.js';
import { createPerformance } from './performance.js';
import { createRecorder, showReplay } from './replay.js';
import { roles, find, node, button, versionUrl, scoreText, createSheets } from './workbench-sheets.js';
import { designerSpeech } from '../../../shared/designer-speech.mjs';
import { deskReactions } from '../../../server/employee-lines.mjs';

const mountedWorkbench = new WeakMap();
const editingStatuses = ['accepted', 'planning', 'working', 'resumed', 'queued', 'running', 'paused'];
const reviewKinds = new Set(['opening', 'review', 'rebuttal']);
const defaultSatisfactionThreshold = 80;
const maxImageBytes = 24 * 1024 * 1024;
const englishDeskReactions = [
  { atWork: 'Whoa! My coffee almost flew! I’m on it!', idle: 'Whoa! The desk heard you. So did I!' },
  { atWork: 'Ow! Even my undo key is sweating. Back to it!', idle: 'No job yet, but my coffee just shipped to the floor!' },
  { atWork: 'Even the paper clips jumped! I’ll get us back on track.', idle: 'Does this desk track hours? Put that one on my timesheet!' },
  { atWork: 'Back to work! That tab was competitive research.', idle: 'The desk wants a reboot. I’ll take an assignment!' },
];
const imageExtensions = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ['gif', 'image/gif'], ['avif', 'image/avif'], ['svg', 'image/svg+xml']
]);

function followsSentence(previous, text) {
  if (!previous) return false;
  const ending = previous.trimEnd();
  if (/\d\.$/u.test(ending) && /^\d/u.test(text.trimStart())) return false;
  return /[。！？.!?…][”’"'」』）)】》\]]*$/u.test(ending);
}

function roundLabel(versionId, order) {
  return `${versionId} · ${t(`第 ${order} 轮`, `Round ${order}`)}`;
}

function missingSpeech(text, parts) {
  let cursor = 0;
  let matched = false;
  const gaps = [];
  const addGap = (end) => {
    const part = text.slice(cursor, end).trim();
    if (/[\p{L}\p{N}]/u.test(part)) gaps.push({
      text: part, clientCue: followsSentence(text.slice(0, cursor), part) ? 'accent' : null,
    });
  };
  for (const [, part] of [...parts.entries()].sort(([first], [second]) => first - second)) {
    const phrase = part.trim();
    const location = text.indexOf(phrase, cursor);
    if (location < 0) continue;
    matched = true;
    if (location > cursor) addGap(location);
    cursor = location + phrase.length;
  }
  if (!matched) return null;
  addGap(text.length);
  return gaps;
}

function bindPosterFullscreen(readArtwork, record) {
  const trigger = find('posterFullscreenBtn');
  const dialog = find('posterFullscreen');
  if (!trigger || !dialog) return null;
  const surface = dialog.querySelector('.poster-fullscreen-surface');
  const closeButton = find('posterFullscreenClose');
  const title = find('posterFullscreenTitle');
  const versionLabel = find('posterFullscreenVersion');
  const image = find('posterFullscreenImage');
  const status = find('posterFullscreenStatus');
  let artwork = null;
  let native = false;

  function exitNative() {
    if (document.fullscreenElement === surface) void document.exitFullscreen().catch(() => {});
  }

  function finishClose() {
    if (dialog.open || !artwork) return;
    const { versionId, draftId } = artwork;
    artwork = null;
    native = false;
    image.removeAttribute('src');
    image.hidden = true;
    status.hidden = true;
    if (!trigger.disabled && trigger.isConnected) trigger.focus({ preventScroll: true });
    record('ui.fullscreen', { open: false, versionId, draftId });
  }

  function close() {
    exitNative();
    if (dialog.open) dialog.close();
    finishClose();
  }

  function settleImage() {
    if (!dialog.open || !artwork || !image.complete) return;
    image.hidden = image.naturalWidth === 0;
    status.hidden = !image.hidden;
    if (!status.hidden) status.textContent = t('无法加载海报。', 'Could not load the poster.');
  }

  function update(next = readArtwork()) {
    trigger.disabled = !next;
    if (!dialog.open) return;
    if (!next) { close(); return; }
    title.textContent = next.title;
    versionLabel.textContent = next.label;
    image.alt = next.alt;
    const changed = artwork?.url !== next.url;
    artwork = next;
    if (!changed) return;
    image.hidden = true;
    status.textContent = t('正在加载海报…', 'Loading poster…');
    status.hidden = false;
    image.setAttribute('src', next.url);
    settleImage();
  }

  trigger.addEventListener('click', () => {
    const selected = readArtwork();
    if (!selected || dialog.open) return;
    dialog.showModal();
    update(selected);
    closeButton.focus({ preventScroll: true });
    record('ui.fullscreen', { open: true, versionId: selected.versionId, draftId: selected.draftId });
    if (document.fullscreenEnabled && !document.fullscreenElement && typeof surface.requestFullscreen === 'function') {
      void surface.requestFullscreen().then(() => {
        if (!dialog.open) exitNative();
        else native = document.fullscreenElement === surface;
      }).catch(() => {});
    }
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', finishClose);
  image.addEventListener('load', settleImage);
  image.addEventListener('error', settleImage);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === surface) {
      if (dialog.open) native = true;
      else exitNative();
    } else if (native && dialog.open) {
      close();
    }
  });
  return { update, close };
}

export function mountWorkbench(options) {
  const owner = find('clientCards');
  if (!owner) return;
  if (!mountedWorkbench.has(owner)) mountedWorkbench.set(owner, initializeWorkbench(options));
  return mountedWorkbench.get(owner);
}

async function initializeWorkbench({ presentNeeds } = {}) {
  const clients = ['zhou', 'lin', 'tang'];
  const draftKey = (id) => `crazy-pm.drafts.${id}`;
  const posting = new Set();
  const localNudges = new Set();
  const scoreCells = new Map();
  const bufferedClientTurns = new Map();
  const speechFailures = new Map();
  const meetingStreams = new Map();
  const retiredMeetingTurns = new Map();
  const historyByRole = new Map();
  const needsByRole = new Map();
  const legacyNeedsViews = new Map();
  const designerStreams = new Map();
  const retiredDesignerTurns = new Set();
  const settingsUrl = withLanguage('/?settings=1');

  let session = null;
  let recorder = null;
  let stream = null;
  let generation = 0;
  let opening = false;
  let eventFloor = 0;
  let employeeTurn = null;
  let shownEmployeeTurn = null;
  let deskCaption = null;
  let deskCaptionTimer;
  let deskHits = 0;
  let remoteReviewTurn = null;
  let presentedReviewTurn = null;
  let retryingRound = null;
  let settingsRevision = 0;
  let speakingQueue = [];
  let playbackGeneration = 0;
  let speechRunning = false;
  let startedSpeechId = null;
  let speechPause = 0;
  let soundBlocked = null;
  let soundEnabled = false;
  let meetingHold = null;
  let changingMeetingMode = false;
  let meetingApprovalChange = null;
  let releasingMeeting = null;
  let reviewingFeedback = null;
  let pendingFeedbackKey = '';
  let camera = { zoom: 1, comparing: false, base: null, located: [] };
  let drafts = { employee: '' };
  let currentRole = null;
  let chatKey = '';
  let scoresKey = '';
  let needsKey = '';
  let artKey = '';
  let canvasKey = '';
  let elementKey = '';
  let jobKey = '';
  let draftAction = null;
  let presentedKey = '';
  let stateFrame = 0;
  let toastTimer = null;
  let preferences = getAudioPreferences();
  let voiceActive = false;
  let liveTranscript = null;

  const roleButtons = [...document.querySelectorAll('.cast-person[data-role]')];
  const employeeInput = find('chatInput');
  const artboard = find('artboard');
  const chat = find('chat');
  const connectionNotice = find('connectionNotice');
  const employeeMic = find('voiceBtn');

  function readStored(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The current session works with storage disabled.
    }
  }

  function persistDrafts() {
    if (session) writeStored(draftKey(session.id), drafts);
  }

  function toast(message, kind = '') {
    if (!message) return;
    const indicator = find('toast');
    clearTimeout(toastTimer);
    indicator.textContent = message;
    indicator.classList.toggle('error', kind === 'error');
    indicator.hidden = false;
    toastTimer = setTimeout(() => { indicator.hidden = true; }, kind === 'error' ? 4800 : 2600);
  }

  function getVersion() {
    return session?.versions?.find((item) => item.id === session.selectedVersionId) ?? session?.versions?.at(-1) ?? null;
  }

  function visibleDraft(version = getVersion()) {
    const draft = session?.draft;
    return draft?.previewUrl && draft.baseVersionId === (version?.id ?? null) ? draft : null;
  }

  function posterArtwork(version = getVersion(), draft = visibleDraft(version)) {
    if (!version && !draft) return null;
    const theme = session.theme;
    const title = theme.name;
    const versionId = version?.id ?? null;
    const label = !versionId ? t('首稿', 'First draft') : draft ? t(`${versionId} 草稿`, `${versionId} draft`) : versionId;
    return {
      title, label, versionId, draftId: draft?.id ?? null,
      width: draft?.width ?? version?.width ?? theme.width ?? 600,
      height: draft?.height ?? version?.height ?? theme.height ?? 800,
      paper: draft?.paper ?? version?.paper,
      url: draft?.previewUrl ?? versionUrl(session, versionId),
      alt: t(`${title} · ${label}海报`, `${title} · ${label} poster`),
    };
  }

  const posterFullscreen = bindPosterFullscreen(posterArtwork, record);

  function getContext() {
    return {
      seq: session?.seq ?? 0,
      role: currentRole,
      versionId: getVersion()?.id ?? null,
      zoom: camera.zoom,
      comparing: camera.comparing,
      comparisonVersionId: camera.base,
      located: [...camera.located],
      drafts: { employee: drafts.employee, meeting: drafts.meeting?.text ?? '', forward: find('forwardDraft')?.value ?? '' },
      dialog: sheets.getCurrent(),
      scroll: { artboard: [artboard.scrollLeft, artboard.scrollTop], chat: [chat.scrollLeft, chat.scrollTop],
        clients: document.querySelector('.clients').scrollTop },
      ...preferences
    };
  }

  function record(type, data = {}) {
    return recorder?.record(type, data);
  }

  function setNotice(message) {
    connectionNotice.textContent = message;
    connectionNotice.hidden = !message;
  }

  const breakout = find('castBreakout');
  const castAnnouncements = find('castAnnouncements');
  const clientCards = find('clientCards');
  const clientPanel = document.querySelector('.clients');
  let speakingFrame = null;
  let breakoutFrame = 0;

  function positionBreakout() {
    if (!speakingFrame) return;
    const origin = speakingFrame.getBoundingClientRect();
    const card = speakingFrame.querySelector('.cast-person').getBoundingClientRect();
    const portrait = speakingFrame.querySelector('.cast-sprite').getBoundingClientRect();
    const bounds = clientPanel.getBoundingClientRect();
    const side = Math.min(window.innerWidth * .62, window.innerHeight * .62,
      Math.max(178, bounds.width * .48, portrait.width * .91));
    const bubble = Math.min(300, Math.max(138, bounds.width * .44), window.innerWidth - 24);
    const limit = Math.min(window.innerWidth - 12, bounds.right + side * .24);
    const targetLeft = Math.max(8, Math.min(origin.right - side * .78, limit - bubble - side * .66));
    const top = origin.bottom + side * .17 < window.innerHeight - 16 ? origin.bottom - side * .83 : origin.top - side * .17;
    const targetTop = Math.max(8, Math.min(window.innerHeight - side - 16, top));
    const geometry = {
      '--cast-x': origin.left, '--cast-y': origin.top, '--cast-width': origin.width, '--cast-height': origin.height,
      '--portrait-x': portrait.left - origin.left, '--portrait-y': portrait.top - origin.top, '--portrait-side': portrait.width,
      '--portrait-crop-top': Math.max(0, card.top - portrait.top), '--portrait-crop-right': Math.max(0, portrait.right - card.right),
      '--portrait-crop-bottom': Math.max(0, portrait.bottom - card.bottom), '--portrait-crop-left': Math.max(0, card.left - portrait.left),
      '--pose-x': targetLeft - portrait.left,
      '--pose-y': targetTop - portrait.top, '--cast-target-x': targetLeft - origin.left,
      '--cast-target-y': targetTop - origin.top, '--cast-side': side, '--cast-bubble-width': bubble
    };
    for (const [name, value] of Object.entries(geometry)) breakout.style.setProperty(name, `${value}px`);
    breakout.style.setProperty('--pose-scale', String(side / Math.max(1, portrait.width)));
    breakout.classList.toggle('is-offscreen', origin.bottom <= Math.max(0, bounds.top) ||
      origin.top >= Math.min(bounds.bottom, window.innerHeight));
  }

  function refreshBreakoutPosition() {
    if (breakout.hidden) return;
    cancelAnimationFrame(breakoutFrame);
    breakoutFrame = requestAnimationFrame(positionBreakout);
  }

  function hideBreakout(turnId) {
    if (turnId && breakout.dataset.turn !== turnId) return;
    breakout.hidden = true;
    speakingFrame?.classList.remove('is-bursting');
    speakingFrame = null;
    delete clientCards.dataset.speakingRole;
  }

  function showBreakout(turn) {
    const frame = roleButtons.find(control => control.dataset.role === turn.role)?.closest('.cast-frame');
    if (!frame) return;
    hideBreakout();
    speakingFrame = frame;
    clientCards.dataset.speakingRole = turn.role;
    frame.classList.add('is-bursting');
    positionBreakout();
    breakout.dataset.role = turn.role;
    breakout.dataset.turn = turn.id;
    find('castBreakoutText').textContent = turn.text;
    breakout.hidden = false;
    const owner = recorder;
    requestAnimationFrame(() => {
      if (breakout.dataset.turn === turn.id && !breakout.hidden) owner?.record('ui.actor-breakout', { role: turn.role, messageId: turn.id, mood: turn.mood });
    });
  }

  const stage = createPerformance({
    recorder: {
      record,
      capture: () => recorder,
      async media(blob, meta) { return recorder?.media(blob, meta); }
    },
    onTranscript: receiveTranscript,
    onVoiceStatus: renderVoiceStatus,
    onAudioReady() {
      soundEnabled = true;
      renderMeetingControls();
    },
    onTurnPrepare(turn) {
      const queued = bufferedClientTurns.get(turn.id);
      if (!queued) return;
      presentedReviewTurn = { ...queued, id: turn.id };
      renderRoundNeeds(getVersion());
    },
    onTurnStart(turn) {
      startedSpeechId = turn.id;
      speechFailures.delete(turn.id);
      soundEnabled = true;
      renderMeetingControls();
      if (clients.includes(turn.role)) {
        const prepared = bufferedClientTurns.get(turn.id);
        bufferedClientTurns.delete(turn.id);
        presentedReviewTurn = { ...prepared, ...turn, phase: 'speaking' };
        showBreakout(turn);
        renderRoundNeeds(getVersion());
        castAnnouncements.textContent = `${roles[turn.role].name} · ${turn.text}`;
        recordSubtitle(turn);
      } else if (turn.role === 'yi') {
        employeeTurn = turn;
        renderEmployeeSpeechFailure();
        renderCaption();
      }
    },
    onTurnEnd(turn) {
      if (clients.includes(turn.role) && breakout.dataset.turn === turn.id) {
        hideBreakout(turn.id);
        if (presentedReviewTurn?.id === turn.id) presentedReviewTurn = null;
        renderRoundNeeds(getVersion());
        castAnnouncements.textContent = '';
        recordSubtitle(null);
      }
      if (employeeTurn?.id === turn.id) {
        employeeTurn = null;
        renderCaption();
      }
    },
    onTurnError: showSpeechFailure,
    getRole: () => 'yi'
  });

  const sheets = createSheets({
    getSession: () => session,
    getVersion,
    record,
    command,
    sendCommand: command,
    notify: toast,
    assign: (data) => sendAssignment(data.text, data),
    selectVersion,
    locate,
    downloadVersion,
    importMaterial,
    prepareMaterial,
    discardDraft: (draftId) => applyDraft('discardDraft', draftId),
    getPreferences: () => preferences,
    setPreference: setAudioPreference,
    acceptRecording() {
      if (session) writeStored(`crazy-pm.recording.${session.id}`, true);
      record('ui.toggle', { name: 'voiceConsent', value: true });
    }
  });

  function applySoundPreferences() {
    stage.setMuted(preferences.muted);
    stage.setVolume(preferences.volume);
    stage.setSoundMix(preferences);
    renderMeetingControls();
  }

  function meetingMode() {
    return session?.meetingMode !== false;
  }

  function currentMeetingRound() {
    const rounds = (session?.reviewRounds ?? []).filter(round => round.meetingMode !== false);
    return rounds.find(round => ['queued', 'running'].includes(round.status)) ?? rounds.at(-1) ?? null;
  }

  function pendingMeetingRound() {
    const versionId = session?.versions?.at(-1)?.id;
    const round = session?.reviewRounds?.findLast(item => item.versionId === versionId);
    return round?.status === 'completed' && round.meetingMode !== false && !round.assignmentJobId &&
      (round.assignmentPending || round.reviewableFeedbackMessageIds?.length) ? round : null;
  }

  function feedbackReceipt(feedback) {
    return node('div', { className: 'review-return' }, node('strong', { text: t('经理已退回', 'Returned by manager') }),
      ...(feedback.text ? [node('span', { text: feedback.text })] : []));
  }

  async function saveFeedbackDecision(roundId, messageId, decision, text) {
    const round = pendingMeetingRound();
    if (!session?.meetingApprovalRequired || round?.id !== roundId || round.releaseRequested || reviewingFeedback || releasingMeeting) return false;
    const action = { sessionId: session.id };
    reviewingFeedback = action;
    renderMeetingAssignment(true);
    try {
      const result = await command('reviewMeetingFeedback', { roundId, messageId, decision, ...(text && { text }) }, { singleFlight: true });
      return Boolean(result && session?.id === action.sessionId);
    } finally {
      if (reviewingFeedback === action) reviewingFeedback = null;
      renderMeetingAssignment(session?.meetingApprovalRequired === true);
    }
  }

  function feedbackRow(round, message, feedback, editable) {
    const header = node('div', { className: 'meeting-feedback-title' }, node('strong', { text: roles[message.role].name }));
    const row = node('li', { attrs: { 'data-message-id': message.id } }, header, node('p', { text: message.text }));
    if (feedback) row.append(feedbackReceipt(feedback));
    if (!editable) return row;

    const reviewButton = (label, action) => {
      const control = button(label, action, 'text-button', `meeting:feedback:${message.id}`);
      control.dataset.reviewAction = 'true';
      return control;
    };
    if (feedback) {
      header.append(reviewButton(t('恢复', 'Restore'), () => { void saveFeedbackDecision(round.id, message.id, 'restore'); }));
      return row;
    }

    const input = node('textarea', { attrs: { rows: '2', maxlength: '1200', 'aria-label': t('退回备注', 'Return note'),
      placeholder: t('备注（可选）', 'Optional note') } });
    const form = node('form', { className: 'meeting-feedback-form', attrs: { hidden: '' } }, input);
    const returnButton = reviewButton(t('退回', 'Return'), () => { form.hidden = false; input.focus(); });
    const submit = node('button', { className: 'button small', text: t('退回意见', 'Return feedback'), attrs: { type: 'submit', 'data-review-action': 'true' } });
    const cancel = reviewButton(t('取消', 'Cancel'), () => { form.hidden = true; returnButton.focus(); });
    form.append(node('div', { className: 'meeting-feedback-actions' }, cancel, submit));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (await saveFeedbackDecision(round.id, message.id, 'return', input.value.trim())) form.hidden = true;
    });
    header.append(returnButton);
    row.append(form);
    return row;
  }

  function renderMeetingAssignment(required) {
    const section = find('meetingAssignment');
    const release = find('releaseMeetingBtn');
    if (!section || !release) return;
    const round = pendingMeetingRound();
    section.hidden = !round;
    if (!round) return;
    const order = session.reviewRounds.indexOf(round) + 1;
    const heading = find('meetingAssignmentRound');
    const label = roundLabel(round.versionId, order);
    if (heading.textContent !== label) heading.textContent = label;
    const list = find('meetingAssignmentFeedback');
    const messages = session.messages ?? [];
    const feedbackIds = round.feedbackMessageIds;
    const reviewableIds = round.reviewableFeedbackMessageIds ?? feedbackIds;
    const feedback = Array.isArray(reviewableIds)
      ? reviewableIds.map(id => messages.find(message => message.id === id)).filter(Boolean)
      : messages.filter(message => (message.roundId === round.id || (!message.roundId && message.versionId === round.versionId && reviewKinds.has(message.kind))));
    const remarks = feedback.filter(message => clients.includes(message.role) && typeof message.text === 'string' && message.text.trim());
    const returned = new Map((round.managerFeedback ?? []).map(item => [item.messageId, item]));
    const editable = required && !round.releaseRequested && Array.isArray(round.reviewableFeedbackMessageIds);
    const key = JSON.stringify([session.id, round.id, editable, round.managerFeedback, remarks.map(message => [message.id, message.text])]);
    if (key !== pendingFeedbackKey) {
      pendingFeedbackKey = key;
      const roundKey = `${session.id}/${round.id}`;
      const scrollTop = list.dataset.roundKey === roundKey ? list.scrollTop : 0;
      list.dataset.roundKey = roundKey;
      list.replaceChildren(...remarks.map(message => feedbackRow(round, message, returned.get(message.id), editable)));
      list.scrollTop = scrollTop;
    }
    const locked = Boolean(releasingMeeting || reviewingFeedback);
    for (const control of list.querySelectorAll('[data-review-action]')) control.disabled = locked;
    const remaining = feedbackIds?.length ?? (round.assignmentPending ? remarks.length : 0);
    const waiting = find('meetingAssignmentWaiting');
    waiting.hidden = required && remaining > 0;
    const waitingLabel = remaining ? t('等待小乙接手', 'Waiting for Xiao Yi') : t('本轮意见均已退回', 'All feedback returned');
    if (waiting.textContent !== waitingLabel) waiting.textContent = waitingLabel;
    release.hidden = !required || !remaining;
    release.disabled = release.hidden || locked || round.releaseRequested === true;
    const actionLabel = round.releaseRequested ? t('意见已排队', 'Feedback queued')
      : releasingMeeting ? t('正在发送…', 'Sending…') : returned.size ? t(`发送通过的 ${remaining} 条意见`, `Send approved feedback (${remaining})`)
        : t('将本轮意见交给小乙', 'Send feedback to Xiao Yi');
    if (release.textContent !== actionLabel) release.textContent = actionLabel;
  }

  function renderMeetingControls() {
    const meeting = meetingMode();
    const mode = find('meetingModeBtn');
    mode.disabled = !session || changingMeetingMode || Boolean(meetingHold || liveTranscript);
    mode.setAttribute('aria-checked', String(meeting));
    find('meetingModeLabel').textContent = meeting ? t('开', 'On') : t('关', 'Off');
    const approval = find('meetingApprovalToggle');
    const required = session?.meetingApprovalRequired === true;
    approval.hidden = Boolean(session) && !meeting;
    approval.disabled = !session || !meeting || changingMeetingMode || Boolean(meetingApprovalChange);
    approval.setAttribute('aria-checked', String(required));
    find('meetingApprovalLabel').textContent = required ? t('开', 'On') : t('关', 'Off');
    renderMeetingAssignment(required);
    const sound = find('soundEnableBtn');
    sound.hidden = !session || (soundEnabled && !soundBlocked && !preferences.muted);
    sound.textContent = soundEnabled ? t('继续播放', 'Resume sound') : t('启用声音', 'Enable sound');
    if (!voiceActive) employeeMic.querySelector('span').textContent = t('按住说话', 'Hold to talk');
    employeeMic.setAttribute('aria-label', t('按住向小乙说话', 'Hold to speak to Xiao Yi'));
  }

  function enableSound() {
    if (preferences.volume === 0) setAudioPreference('volume', .9);
    if (preferences.muted) setAudioPreference('muted', false);
    else resumeSound();
  }

  function resumeSound() {
    stage.unlockAudio();
    soundEnabled = true;
    if (soundBlocked) speechPause += 1;
    soundBlocked = null;
    renderMeetingControls();
    kickSpeech();
  }

  function createScores() {
    const board = find('clientCards');
    for (const id of clients) {
      const select = button('', () => sheets.score(id), 'cast-score', `score:${id}`);
      select.dataset.scoreRole = id;
      select.append(node('span', { className: 'cast-score-fill', attrs: { 'aria-hidden': 'true' } }));
      scoreCells.set(id, select);
      board.querySelector(`[data-score-slot="${id}"]`)?.append(select);
    }
  }

  function renderScores(version) {
    const key = JSON.stringify([version?.id, version?.satisfactionThreshold, version?.review]);
    if (key === scoresKey) return;
    scoresKey = key;
    for (const [id, cell] of scoreCells) {
      const summary = version?.review?.[id];
      const score = Number.isFinite(summary?.score) ? summary.score : null;
      const pending = score === null && summary?.pendingWeight > 0;
      const reference = Number.isFinite(summary?.previousScore) ? summary.previousScore : null;
      const lowerBound = Number.isFinite(summary?.lowerBound) ? summary.lowerBound : null;
      const measured = score ?? (pending ? reference ?? lowerBound : null);
      const target = summary?.satisfactionThreshold ?? summary?.threshold ?? version?.satisfactionThreshold;
      const threshold = Number.isFinite(target) && target >= 0 && target <= 100 ? target : defaultSatisfactionThreshold;
      const met = score !== null && score >= threshold;
      const name = roles[id].name;
      let label = t(`${name}满意度尚未评分`, `${name}'s satisfaction is unscored`);
      if (score !== null) {
        label = t(`${name}满意度 ${score}/100，${met ? '已达到' : '未达到'} ${threshold} 分`,
          `${name}'s satisfaction is ${score} out of 100, ${met ? 'meeting' : 'below'} the ${threshold}-point target`);
      } else if (pending) {
        label = t(`${name}满意度待验证`, `${name}'s satisfaction is pending verification`);
        if (reference !== null) label += t(`，参考已确认的 ${reference}/100`, `, with a previous verified score of ${reference} out of 100`);
        else if (lowerBound !== null) label += t(`，已知至少 ${lowerBound}/100`, `, with at least ${lowerBound} out of 100 verified`);
      }
      cell.dataset.state = score === null ? (pending ? 'pending' : 'unknown') : met ? 'met' : 'unmet';
      cell.style.setProperty('--satisfaction', String(Math.min(1, Math.max(0, (measured ?? 0) / 100))));
      cell.disabled = !summary;
      cell.setAttribute('aria-label', summary ? `${label}${t('，查看评分依据', '. View scoring details')}` : label);
      cell.title = summary ? t('查看评分依据', 'View scoring details') : label;
    }
  }

  function reviewRound(version) {
    if (!version) return null;
    return session?.reviewRounds?.findLast((item) => item.versionId === version?.id) ?? null;
  }

  function reviewHistory() {
    const rounds = new Map((session?.reviewRounds ?? []).map((round, index) => [round.id, { ...round, order: index + 1 }]));
    const versionOrder = new Map((session?.versions ?? []).map((version, index) => [version.id, index + 1]));
    const firstRoundByVersion = new Map();
    const managerFeedback = new Map();
    for (const round of rounds.values()) {
      if (!firstRoundByVersion.has(round.versionId)) firstRoundByVersion.set(round.versionId, round);
      for (const feedback of round.managerFeedback ?? []) managerFeedback.set(feedback.messageId, feedback);
    }
    const grouped = new Map(clients.map(role => [role, new Map()]));
    const committed = new Set();

    function add(turn, line) {
      const versionId = turn.versionId ?? session?.versions?.[0]?.id ?? t('早期版本', 'Earlier version');
      const round = rounds.get(turn.roundId) ?? firstRoundByVersion.get(versionId) ?? {
        id: `legacy:${versionId}`, versionId, order: versionOrder.get(versionId) ?? 1,
      };
      const roleGroups = grouped.get(turn.role);
      if (!roleGroups) return;
      let group = roleGroups.get(round.id);
      if (!group) {
        group = { id: round.id, versionId: round.versionId, order: round.order, lines: new Map() };
        roleGroups.set(round.id, group);
      }
      group.lines.set(line.id, line);
    }

    for (const turn of session?.messages ?? []) {
      if (turn.turnId) committed.add(turn.turnId);
      if (!clients.includes(turn.role) || turn.mode === 'local' || !turn.text || retiredMeetingTurns.get(turn.turnId) === 'cancelled') continue;
      add(turn, { id: turn.turnId ?? turn.id, text: turn.text, feedback: managerFeedback.get(turn.id) });
    }
    for (const [turnId, stream] of meetingStreams) {
      if (committed.has(turnId)) continue;
      const text = [...stream.parts.entries()].sort(([first], [second]) => first - second).map(([, part]) => part).join(' ');
      if (text) add(stream, { id: turnId, text, streaming: true });
    }
    return Object.fromEntries(clients.map(role => {
      const previous = historyByRole.get(role) ?? [];
      const priorGroups = new Map(previous.map(group => [group.id, group]));
      const next = [...grouped.get(role).values()].sort((first, second) => first.order - second.order).map(group => {
        const lines = [...group.lines.values()];
        const key = JSON.stringify([group.versionId, group.order, lines]);
        const prior = priorGroups.get(group.id);
        return prior?.key === key ? prior : { ...group, lines, key, label: roundLabel(group.versionId, group.order) };
      });
      const shared = next.length === previous.length && next.every((group, index) => group === previous[index]) ? previous : next;
      historyByRole.set(role, shared);
      return [role, shared];
    }));
  }

  function viewSource(item) {
    return sheets.requirementSource(item, item.source);
  }

  function forward(item) {
    return sheets.forward([item]);
  }

  function renderRoundNeeds(version) {
    const meeting = meetingMode();
    const round = meeting ? currentMeetingRound() : reviewRound(version);
    const rounds = session?.reviewRounds ?? [];
    const status = round?.status ?? '';
    const roundKey = version ? (meeting ? `${session.id}/meeting` : `${session.id}/${version.id}/${round?.id ?? ''}`) : '';
    const history = reviewHistory();
    const entries = session?.requirements ?? [];
    const matchesRound = (turn) => Boolean(version && turn && (!turn.versionId || turn.versionId === version.id) &&
      (!turn.roundId || !round || turn.roundId === round.id));
    const matchesPresentation = (turn) => meeting ? Boolean(version && turn) : matchesRound(turn);
    const upcoming = !meetingHold && [...bufferedClientTurns.values()].find(matchesPresentation);
    const queued = Boolean(upcoming);
    const active = [presentedReviewTurn, upcoming, status === 'failed' ? null : remoteReviewTurn].find(matchesPresentation);
    const failure = status === 'failed' && round.error ? round.error : null;
    const voiceErrors = [...speechFailures.values()].filter(item => clients.includes(item.turn.role) && matchesPresentation(item.turn));
    const waitingPoster = Boolean(session && !version);
    const waitingPublication = waitingPoster && Boolean(visibleDraft(null));
    const historyKey = clients.map(role => history[role].map(group => [group.id, group.key]));
    const key = JSON.stringify([roundKey, version?.id, meeting, status, round?.turnCount, historyKey, meeting ? null : entries, waitingPoster, waitingPublication, active?.role, active?.phase,
      [...bufferedClientTurns.keys()], failure, retryingRound?.id, voiceErrors.map(({ turn, reason, busy }) => [turn.id, reason, busy])]);
    if (key === needsKey) return;
    needsKey = key;
    const messages = new Map((session?.messages ?? []).map((message) => [message.id, message]));
    const requirements = meeting ? [] : entries.flatMap((item) => {
      if (!clients.includes(item.role) || !version) return [];
      let source = messages.get(item.sourceMessageId);
      if (!item.versionId && !item.roundId) {
        const ids = [...new Set([item.originalMessageId, ...(item.sourceMessageIds ?? []), item.sourceMessageId])];
        source = ids.map((id) => messages.get(id)).findLast((message) => message?.versionId === version.id) ?? source;
      }
      const roundId = item.roundId ?? source?.roundId;
      const versionId = item.versionId ?? rounds.find((record) => record.id === roundId)?.versionId ?? source?.versionId;
      if ((versionId && versionId !== version.id) || (roundId && round && roundId !== round.id)) return [];
      if (!versionId && session.versions[0]?.id !== version.id) return [];
      if (bufferedClientTurns.get(source?.id ?? item.sourceMessageId)?.holdNeeds) return [];
      const historical = source && source.id !== item.sourceMessageId;
      const original = historical && [source.requirement, ...(source.requirements ?? [])].find((entry) => entry?.id === item.id);
      const display = original || item;
      const text = display?.displayInstruction || display?.text || display?.goal || source?.text;
      return text ? [{ ...item, text, displayInstruction: display?.displayInstruction, sourceMessageId: source?.id ?? item.sourceMessageId, source }] : [];
    });
    const spoken = new Set();
    if (round && (status !== 'completed' || queued)) {
      for (const message of messages.values()) {
        if (message.roundId === round.id && reviewKinds.has(message.kind) &&
          !bufferedClientTurns.get(message.id)?.holdNeeds) spoken.add(message.role);
      }
    }
    const labels = {
      'waiting-poster': waitingPublication ? t('等首稿发布', 'Waiting for publication') : t('等初稿', 'Waiting for the first draft'), thinking: t('思考中', 'Thinking'),
      preparing: t('准备配音', 'Preparing audio'), speaking: t('正在发言', 'Speaking')
    };
    const groups = clients.map((role) => {
      const phase = waitingPoster ? 'waiting-poster' : active?.role === role ? active.phase : '';
      const failures = voiceErrors.filter(item => item.turn.role === role).map(speechFailureNotice);
      if (failure && role === (failure.role ?? clients[0])) {
        const busy = retryingRound?.id === round.id;
        failures.unshift({ id: round.id, action: 'review', label: t('评审失败', 'Review failed'),
          message: failure.message, settings: failure.code === 'unconfigured' ? t('配置 Agent', 'Configure Agent') : '',
          actionLabel: busy ? t('正在重试…', 'Retrying…') : t('重试本轮', 'Retry this review'), busy });
      }
      const items = requirements.filter(item => item.role === role);
      const awaiting = Boolean(round && (status !== 'completed' || queued) && !spoken.has(role));
      const signature = JSON.stringify([phase, labels[phase], failures, meeting, items, awaiting]);
      const previous = needsByRole.get(role);
      if (previous?.signature === signature && previous.group.history === history[role]) return previous.group;
      const group = { role, phase, phaseLabel: labels[phase], failures, meeting, items, history: history[role], awaiting };
      needsByRole.set(role, { signature, group });
      return group;
    });
    if (presentNeeds) {
      presentNeeds({ roundKey, selectedVersionId: version?.id, groups, viewSource, forward, retry: retryOnlineFailure });
      return;
    }

    for (const group of groups) {
      const { role, items, history: sections = [], awaiting, phase, phaseLabel, failures } = group;
      const panel = clientCards.querySelector(`[data-needs-role="${role}"]`);
      if (!panel) continue;
      const previous = legacyNeedsViews.get(role);
      if (previous?.group === group && previous.versionId === version?.id && previous.roundKey === roundKey) continue;
      legacyNeedsViews.set(role, { group, versionId: version?.id, roundKey });
      const frame = panel.closest('.cast-frame');
      frame.dataset.reviewPhase = phase;
      frame.querySelector('.cast-person').disabled = phase === 'waiting-poster';
      panel.setAttribute('aria-label', meeting ? t(`${roles[role].name}的会议发言`, `${roles[role].name}'s meeting remarks`)
        : t(`${roles[role].name}本轮需求`, `${roles[role].name}'s requests this round`));
      const transcript = sections.length ? node('div', { className: 'meeting-transcript' }, ...sections.map(current =>
        node('section', { className: 'meeting-transcript-round', attrs: { 'data-selected-version': String(current.versionId === version?.id) } },
          node('h3', { text: current.label }), ...current.lines.map(line =>
            node('div', { className: 'meeting-transcript-turn' },
              node('p', { text: line.text, attrs: line.streaming ? { 'data-streaming': 'true' } : {} }),
              ...(line.feedback ? [feedbackReceipt(line.feedback)] : [])))))) : null;
      const content = meeting ? transcript : items.length ? node('ul', { className: 'cast-need-list' },
        ...items.map((item) => node('li', { attrs: { 'data-requirement-id': item.id } },
          node('p', { text: item.text }),
          node('div', { className: 'round-need-actions' },
            ...(item.source ? [button(t('原话', 'Quote'), () => viewSource(item), 'text-button', `round-needs:source:${item.id}`)] : []),
            button(t('转小乙', 'Forward'), () => forward(item), 'text-button', `round-needs:forward:${item.id}`)
          )))) : null;
      const changed = panel.dataset.round !== roundKey;
      const scrollTop = panel.scrollTop;
      const following = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 25;
      const historyOpen = panel.querySelector('.cast-history')?.open === true;
      panel.replaceChildren();
      if (phaseLabel) panel.append(node('p', { className: 'cast-review-status', text: phaseLabel }));
      for (const issue of failures) panel.append(failureElement(issue));
      if (content) panel.append(content);
      else if (roundKey && !phaseLabel && !failures.length) panel.append(node('p', { className: 'round-need-empty',
        text: meeting ? t('等待会议发言', 'Waiting for meeting remarks')
          : awaiting ? t('等待发言', 'Waiting to speak') : t('本轮暂无需求', 'No requests this round') }));
      if (!meeting && transcript) {
        const disclosure = node('details', { className: 'cast-history' }, node('summary', { text: t('评审历史', 'Review history') }), transcript);
        disclosure.open = historyOpen;
        panel.append(disclosure);
      }
      panel.dataset.round = roundKey;
      panel.scrollTop = meeting && (changed || following) ? panel.scrollHeight : changed ? 0 : scrollTop;
      if (items.length || sections.length || failures.length) panel.tabIndex = 0;
      else panel.removeAttribute('tabindex');
    }
  }

  function selectedRole() {
    return clients.includes(session?.selectedRole) ? session.selectedRole : 'zhou';
  }

  function setEmployeeDraft(text, source = 'input') {
    drafts.employee = text;
    renderComposerTarget();
    persistDrafts();
    record('ui.draft', { target: 'employee', role: 'yi', value: text, source });
  }

  function renderComposerTarget() {
    const voiceDraft = drafts.meeting;
    const text = liveTranscript?.text ?? voiceDraft?.text ?? drafts.employee ?? '';
    if (employeeInput.value !== text) employeeInput.value = text;
    employeeInput.readOnly = Boolean(liveTranscript);
    const editable = Boolean(getVersion() || visibleDraft(null));
    employeeInput.disabled = !session || (!editable && !voiceDraft && !liveTranscript);
    const form = find('chatForm');
    const send = form.querySelector('button[type="submit"]');
    const busy = form.getAttribute('aria-busy') === 'true';
    send.disabled = busy || !session || (!editable && !voiceDraft) || Boolean(liveTranscript);
    if (!busy) send.textContent = voiceDraft ? t('发送语音稿', 'Send transcript') : t('发送', 'Send');
    find('cancelMeetingDraft')?.toggleAttribute('hidden', Boolean(liveTranscript) || !voiceDraft);
    employeeInput.placeholder = liveTranscript ? t('正在听…', 'Listening…') : voiceDraft
      ? t('语音稿', 'Voice transcript') : t('给小乙派工', 'Assign a change to Xiao Yi');
  }

  function setMeetingDraft(text, { roundId, versionId }) {
    drafts.meeting = { text, roundId, versionId };
    persistDrafts();
    renderComposerTarget();
    record('ui.draft', { target: 'employee', role: 'yi', value: text, source: 'voice' });
  }

  function clearMeetingDraft() {
    delete drafts.meeting;
    persistDrafts();
    renderComposerTarget();
  }

  function renderRole() {
    const role = selectedRole();
    if (currentRole === role) return;
    currentRole = role;
    for (const control of roleButtons) control.setAttribute('aria-pressed', String(control.dataset.role === role));
  }

  function recordSubtitle(turn, placement = 'client') {
    const id = turn?.id ?? null;
    const data = { messageId: id, role: turn?.role ?? null, text: turn?.text ?? '', placement };
    const owner = recorder;
    requestAnimationFrame(() => owner?.record('subtitle.presented', data));
  }

  function speechFailureNotice({ turn, reason, busy }) {
    const enable = reason === 'autoplay-blocked' || reason === 'muted';
    const setup = ['unconfigured', 'missing-key', 'missing-voice'].includes(reason);
    const messages = {
      'autoplay-blocked': t('浏览器正在等待启用声音。', 'The browser is waiting for you to enable sound.'),
      muted: t('当前声音已关闭。', 'Sound is turned off.'),
      unconfigured: t('请先选择在线配音服务。', 'Choose an online text-to-speech service.'),
      'missing-key': t('配音服务需要 API 密钥。', 'The voice service needs an API key.'),
      'missing-voice': t('这个角色还未设置音色。', 'This character needs a voice.'),
      timeout: t('配音服务响应超时。', 'The voice service timed out.'),
      'audio-unsupported': t('当前浏览器无法播放这段音频。', 'This browser cannot play the audio.'),
      'invalid-input': t('配音服务无法处理这段台词。', 'The voice service could not process this line.')
    };
    const actionLabel = busy ? t('正在重试…', 'Retrying…')
      : enable ? t('启用声音', 'Enable sound') : t('重试配音', 'Retry audio');
    return { id: turn.id, action: 'voice', label: t('配音失败', 'Audio failed'), text: turn.role === 'yi' || meetingMode() ? '' : turn.text,
      message: messages[reason] ?? t('没有收到可播放的音频。', 'No playable audio was returned.'),
      settings: setup ? t('配置配音', 'Configure voices') : '',
      actionLabel: ['audio-unsupported', 'invalid-input'].includes(reason) ? '' : actionLabel, busy };
  }

  function failureElement(issue) {
    const actions = node('div', { className: 'online-failure-actions' });
    if (issue.settings) actions.append(node('a', { text: issue.settings, attrs: { href: settingsUrl, target: '_blank', rel: 'noopener' } }));
    if (issue.actionLabel) {
      const retry = button(issue.actionLabel, () => retryOnlineFailure(issue), 'button small', `${issue.action}:retry:${issue.id}`);
      retry.disabled = Boolean(issue.busy);
      actions.append(retry);
    }
    return node('div', { className: 'online-failure' },
      node('strong', { text: issue.label, attrs: { role: 'status' } }),
      ...(issue.message ? [node('p', { text: issue.message })] : []),
      ...(issue.text ? [node('p', { className: 'online-failure-quote', text: issue.text })] : []), actions);
  }

  function showSpeechFailure(turn, reason) {
    const prepared = bufferedClientTurns.get(turn.id);
    const message = { ...prepared, ...turn, versionId: turn.versionId ?? prepared?.versionId };
    bufferedClientTurns.delete(turn.id);
    if (presentedReviewTurn?.id === turn.id) presentedReviewTurn = null;
    speechFailures.set(turn.id, { turn: message, reason, busy: false });
    if (speakingQueue[0]?.id === turn.id && ['autoplay-blocked', 'muted'].includes(reason)) {
      soundBlocked = turn.id;
      renderMeetingControls();
    }
    if (turn.role === 'yi') renderEmployeeSpeechFailure();
    else renderRoundNeeds(getVersion());
  }

  function renderEmployeeSpeechFailure() {
    const box = find('employeeSpeechFailure');
    const issue = [...speechFailures.values()].findLast(item => item.turn.role === 'yi');
    const key = issue ? `${issue.turn.id}/${issue.reason}/${issue.busy}` : '';
    box.hidden = !issue;
    if (box.dataset.issue === key) return;
    box.dataset.issue = key;
    box.replaceChildren(...(issue ? [failureElement(speechFailureNotice(issue))] : []));
  }

  async function retryOnlineFailure(issue) {
    if (issue.action === 'review') {
      const round = meetingMode() ? currentMeetingRound() : reviewRound(getVersion());
      if (round?.id !== issue.id || round.status !== 'failed' || retryingRound) return;
      const attempt = { id: round.id };
      retryingRound = attempt;
      renderRoundNeeds(getVersion());
      try {
        await command('retryReview', { roundId: round.id }, { singleFlight: true });
      } finally {
        if (retryingRound === attempt) {
          retryingRound = null;
          renderRoundNeeds(getVersion());
        }
      }
      return;
    }
    const failure = speechFailures.get(issue.id);
    if (!session || !failure || failure.busy) return;
    if (soundBlocked === issue.id) {
      enableSound();
      return;
    }
    if (failure.reason === 'muted') setAudioPreference('muted', false);
    stage.unlockAudio();
    failure.busy = true;
    bufferClientTurn(failure.turn, failure.turn.versionId, false);
    renderRoundNeeds(getVersion());
    renderEmployeeSpeechFailure();
    record('ui.voice-retry', { messageId: failure.turn.id, role: failure.turn.role, reason: failure.reason });
    playTurns([failure.turn], { retry: true });
  }

  function renderCaption() {
    const job = session?.job;
    const active = editingStatuses.includes(job?.status);
    const working = job?.initial ? t('正在画初稿。', 'Drawing the first draft.')
      : job?.status === 'planning' ? t('正在看工单。', 'Reviewing the assignment.') : t('在改了。', 'Working on it.');
    const waiting = session?.draft ? t('这稿等你确认。', 'This draft is ready for your approval.') : t('等你派工。', 'Ready for an assignment.');
    const fallback = job?.status === 'paused' ? t('就看十五秒……', 'Just fifteen more seconds…') : active ? working : waiting;
    const recent = session?.messages?.findLast((message) => message.role === 'yi');
    const caption = find('agentCaption');
    const progress = active ? [...designerStreams.values()].findLast(stream => stream.jobId === job.id)?.latest : null;
    const turn = deskCaption ?? employeeTurn ?? progress;
    const text = turn?.text ?? (active ? fallback : recent?.text ?? fallback);
    if ((turn?.id ?? null) !== shownEmployeeTurn) {
      shownEmployeeTurn = turn?.id ?? null;
      recordSubtitle(turn, 'employee');
    }
    if (caption.textContent === text) return;
    caption.textContent = text;
    caption.title = text;
  }

  function renderJob() {
    const job = session?.job;
    const version = getVersion();
    const basis = find('draftBasis');
    const draft = visibleDraft(version);
    let versionLabel = version ? t(`基于 ${version.id}`, `Based on ${version.id}`) : '';
    if (draft) versionLabel = version ? t(`${version.id} 草稿`, `${version.id} draft`) : t('首稿', 'First draft');
    if (basis.textContent !== versionLabel) basis.textContent = versionLabel;
    const key = JSON.stringify(job ?? null);
    if (key === jobKey) return;
    jobKey = key;
    stage.setJob(job?.status === 'planning' ? { ...job, status: 'working' } : job ?? null);
    const status = job?.status ?? 'idle';
    const first = job?.initial === true;
    const labels = {
      idle: t('待命', 'Ready'), queued: t('已接单', 'Accepted'), accepted: t('已接单', 'Accepted'),
      planning: first ? t('画初稿', 'Drawing first draft') : t('规划中', 'Planning'),
      working: first ? t('画初稿', 'Drawing first draft') : t('改稿中', 'Editing'), running: t('改稿中', 'Editing'), resumed: t('已复工', 'Resumed'),
      awaitingApproval: first ? t('待发布', 'Ready to publish') : t('等经理确认', 'Awaiting approval'),
      paused: t('摸鱼中', 'Slacking off'), completed: t('已交稿', 'Delivered'), delivered: t('已交稿', 'Delivered'), done: t('已交稿', 'Delivered'),
      failed: first ? t('初稿生成失败', 'First draft failed') : t('改稿出错', 'Edit failed'),
      clarification: t('待确认', 'Needs clarification'), needs_clarification: t('待确认', 'Needs clarification'),
      cancelled: t('已取消', 'Canceled')
    };
    const statusLabel = labels[status] ?? labels.idle;
    if (find('agentStatus').textContent !== statusLabel) find('agentStatus').textContent = statusLabel;
    find('agentStage').dataset.jobStatus = status;
    const progress = find('workProgress');
    const showProgress = Boolean(job) && !['idle', 'awaitingApproval', 'clarification', 'needs_clarification', 'cancelled'].includes(status);
    progress.hidden = !showProgress;
    progress.dataset.status = status;
    const task = find('taskLabel');
    const taskLabel = job?.error ?? job?.label ?? labels[status] ?? t('工单', 'Assignment');
    if (task.textContent !== taskLabel) task.textContent = taskLabel;
    const percent = Number(job?.progress) || 0;
    find('taskBar').value = percent;
    find('taskPercent').textContent = `${percent}%`;
    const retry = find('retryJob');
    retry.hidden = status !== 'failed';
    retry.textContent = first ? t('重试初稿', 'Retry first draft') : t('重试工单', 'Retry assignment');
    find('jobSetupLink').hidden = status !== 'failed' || job?.errorCode !== 'unconfigured';
    find('slapBtn').classList.toggle('urgent', status === 'paused');
  }

  function renderDraftControls() {
    const section = find('draftApproval');
    if (!section) return;
    const draft = session?.draft;
    section.hidden = !draft;
    section.closest('.agent-panel').dataset.hasDraft = String(Boolean(draft));
    if (!draft) return;
    const visible = Boolean(visibleDraft());
    const pending = draftAction?.sessionId === session.id;
    const locked = pending || editingStatuses.includes(session.job?.status);
    const first = draft.baseVersionId === null;
    find('draftApprovalHeading').textContent = first ? t('首稿待发布', 'First draft ready') : t('草稿', 'Draft');
    const detail = [draft.baseVersionId];
    if (draft.iteration > 0) detail.push(t(`第 ${draft.iteration} 稿`, `Draft ${draft.iteration}`));
    find('draftApprovalDetail').textContent = detail.join(' · ');
    const confirm = find('confirmDraftBtn');
    confirm.disabled = !visible || locked;
    confirm.textContent = pending && draftAction.type === 'confirmDraft' ? t('正在确认…', 'Approving…')
      : first ? t('发布首稿', 'Publish first draft') : t('确认草稿', 'Approve draft');
    find('discardDraftBtn').disabled = locked;
  }

  function renderChat() {
    const messages = (session?.messages ?? []).filter((message) =>
      message.role === 'yi' ||
      (message.role === 'manager' && (message.target === 'yi' || message.targetRole === 'yi' || message.to === 'yi' ||
        ['assignment', 'assign', 'instruction', 'work_order', 'nudge', 'dispatch', 'forward', 'task', 'meeting-interjection'].includes(message.kind)))
    );
    const completed = new Set(messages.filter(message => message.role === 'yi').map(message => message.turnId));
    const unsettled = [...designerStreams.values()].filter(stream => !completed.has(stream.id));
    const liveMessages = unsettled.map(stream => ({
      id: `designer:${stream.id}`, turnId: stream.id, role: 'yi', text: stream.text, live: true,
    }));
    const key = JSON.stringify([messages.map(message => message.id), liveMessages.map(({ id, text }) => [id, text])]);
    if (key === chatKey) return;
    const shouldFollow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 30 || !chatKey;
    const previous = new Map([...chat.children].map(article => [article.dataset.chatKey, article]));
    let cursor = chat.firstElementChild;
    chatKey = key;
    for (const message of [...messages, ...liveMessages]) {
      const displayKey = message.role === 'yi' && message.turnId ? `designer:${message.turnId}` : message.id;
      const article = previous.get(displayKey) ?? node('article', {
        className: `message ${message.role === 'manager' ? 'manager' : 'employee'}`, attrs: { 'data-chat-key': displayKey },
      }, node('span', { className: 'message-name' }), node('p'));
      article.dataset.messageId = message.id;
      const title = message.live ? `${roles.yi.name} · ${t('实时进度', 'Live progress')}` : roles[message.role].name;
      const [name, body] = article.children;
      if (name.textContent !== title) name.textContent = title;
      if (body.textContent !== message.text) body.textContent = message.text;
      if (article === cursor) cursor = cursor.nextElementSibling;
      else chat.insertBefore(article, cursor);
      previous.delete(displayKey);
    }
    for (const article of previous.values()) article.remove();
    if (shouldFollow) chat.scrollTop = chat.scrollHeight;
  }
  
  function setImage(img, url) {
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  }

  function previousVersion(version) {
    return session.versions.find((item) => item.id === version?.parentId) ??
      session.versions.find((item) => item.id !== version?.id) ?? null;
  }

  function renderElements() {
    const overlay = find('elementOverlay');
    const version = getVersion();
    const draft = visibleDraft(version);
    const key = JSON.stringify([session?.id, version?.id, draft?.id, ...camera.located]);
    if (key === elementKey) return;
    elementKey = key;
    const artwork = posterArtwork(version, draft);
    const vw = artwork?.width ?? 600;
    const vh = artwork?.height ?? 800;
    const ids = new Set(camera.located);
    const elements = (draft?.elements ?? version?.elements ?? []).filter((item) =>
      ids.has(item.id) && [item.x, item.y, item.w, item.h].every(Number.isFinite) && item.w > 0 && item.h > 0);
    overlay.hidden = elements.length === 0;
    overlay.replaceChildren(...elements.map((item) => {
      const box = node('span', { className: `locate-box${item.y < 30 ? ' at-top' : ''}` }, node('span', { text: item.label }));
      box.style.left = `${item.x * 100 / vw}%`;
      box.style.top = `${item.y * 100 / vh}%`;
      box.style.width = `${item.w * 100 / vw}%`;
      box.style.height = `${item.h * 100 / vh}%`;
      return box;
    }));
  }

  function renderCanvas() {
    const version = getVersion();
    const draft = visibleDraft(version);
    const artwork = posterArtwork(version, draft);
    posterFullscreen?.update(artwork);
    const empty = find('initialPoster');
    empty.hidden = Boolean(artwork);
    empty.closest('.canvas-panel').dataset.empty = String(!artwork);
    if (!artwork) {
      const job = session?.job;
      const failed = job?.status === 'failed';
      const percent = Math.min(100, Math.max(0, Number(job?.progress) || 0));
      const key = JSON.stringify([session?.id, job?.status, percent]);
      if (canvasKey === key) return;
      canvasKey = key;
      empty.dataset.status = failed ? 'failed' : '';
      find('initialPosterStatus').textContent = failed ? t('初稿生成失败', 'First draft failed')
        : session ? t('小乙正在绘制初稿', 'Xiao Yi is drawing the first draft') : t('正在打开项目…', 'Opening project…');
      find('initialPosterProgress').hidden = !session || failed;
      find('initialPosterBar').value = percent;
      find('initialPosterPercent').textContent = `${percent}%`;
      find('posterWrap').hidden = true;
      find('poster').removeAttribute('src');
      find('comparison').hidden = true;
      find('compareTab').disabled = true;
      const count = find('versionCount');
      if (count) count.textContent = '0';
      find('exportLabel').textContent = t('导出海报', 'Export poster');
      find('exportBtn').removeAttribute('title');
      document.querySelector('.zoom-controls').hidden = true;
      return;
    }
    const versionId = version?.id;
    const issues = version ? (version.issues ?? session.issues ?? []).filter(issue =>
      issue.status !== 'resolved' && (!issue.versionId || issue.versionId === versionId)) : [];
    const options = version ? session.versions.filter(item => draft || item.id !== versionId) : [];
    const candidate = camera.comparing && options.length ? options.find(item => item.id === camera.base) ?? (draft ? version : previousVersion(version)) : null;
    const comparing = Boolean(candidate);
    camera.comparing = comparing;
    if (comparing) camera.base = candidate.id;
    const key = JSON.stringify([session.id, artwork, version?.label, session.versions.length, session.finalizedVersionId,
      issues.length, camera.zoom, candidate?.id]);
    if (canvasKey === key) {
      renderElements();
      return;
    }
    canvasKey = key;
    artboard.style.setProperty('--aspect', String(artwork.width / artwork.height));
    artboard.style.setProperty('--zoom', String(camera.zoom));
    const name = find('versionName');
    name.textContent = versionId ?? t('首稿', 'First draft');
    name.title = version?.label ?? '';
    const legacyLabel = find('versionLabel');
    if (legacyLabel) legacyLabel.textContent = version?.label ?? '';
    const count = find('versionCount');
    if (count) count.textContent = String(session.versions.length);
    const size = find('canvasSize');
    const pixels = `${artwork.width}×${artwork.height} px`;
    const paper = artwork.paper;
    const millimetres = paper?.widthMm && paper.heightMm ? `${paper.widthMm}×${paper.heightMm} mm` : '';
    size.textContent = [paper?.format, millimetres || pixels].filter(Boolean).join(' · ');
    size.title = millimetres ? `${size.textContent} · ${pixels}` : pixels;
    const draftFlag = find('draftFlag');
    if (draftFlag) {
      draftFlag.hidden = !draft;
      draftFlag.textContent = versionId ? t('草稿', 'Draft') : t('待发布', 'Unpublished');
    }
    find('finalizedFlag').hidden = !versionId || Boolean(draft) || session.finalizedVersionId !== versionId;
    find('exportLabel').textContent = versionId ? t(`导出 ${versionId}`, `Export ${versionId}`) : t('导出海报', 'Export poster');
    find('exportBtn').title = versionId ? t(`导出已确认的 ${versionId}`, `Export approved version ${versionId}`) : '';
    find('compareTab').disabled = options.length === 0;
    const conflictButton = find('resolveConflict');
    conflictButton.hidden = issues.length === 0;
    const disputeLabel = t(`${issues.length} 项分歧`, issues.length === 1 ? '1 dispute' : `${issues.length} disputes`);
    const disputeCount = find('disputeCount');
    if (disputeCount) disputeCount.textContent = String(issues.length);
    else conflictButton.textContent = disputeLabel;
    conflictButton.title = disputeLabel;
    conflictButton.setAttribute('aria-label', disputeLabel);
    const poster = find('poster');
    poster.alt = artwork.alt;
    const currentUrl = artwork.url;
    setImage(poster, currentUrl);

    find('posterWrap').hidden = comparing;
    find('comparison').hidden = !comparing;
    find('previewTab').setAttribute('aria-selected', String(!comparing));
    find('compareTab').setAttribute('aria-selected', String(comparing));
    find('previewTab').tabIndex = comparing ? -1 : 0;
    find('compareTab').tabIndex = comparing ? 0 : -1;
    document.querySelector('.zoom-controls').hidden = comparing;
    if (comparing) {
      const list = find('compareVersion');
      const newKey = `${session.id}/${versionId}/${session.versions.length}/${Boolean(draft)}`;
      if (artKey !== newKey) {
        artKey = newKey;
        list.replaceChildren(...options.map((item) =>
          node('option', { text: item.id, attrs: { value: item.id, title: item.label ?? '' } })));
      }
      list.value = candidate.id;
      find('afterLabel').textContent = artwork.label;
      const basis = posterArtwork(candidate, null);
      const before = find('beforeArt');
      before.alt = basis.alt;
      before.style.setProperty('--aspect', String(basis.width / basis.height));
      setImage(before, basis.url);
      const after = find('afterArt');
      after.alt = poster.alt;
      after.style.setProperty('--aspect', String(artwork.width / artwork.height));
      setImage(after, currentUrl);
    }
    find('zoomLabel').textContent = camera.zoom === 1 ? t('适应', 'Fit') : `${Math.round(camera.zoom * 100)}%`;
    renderElements();
  }

  function render() {
    const version = getVersion();
    const title = session?.theme?.name;
    if (title && find('projectName').textContent !== title) {
      find('projectName').textContent = title;
      document.title = t(`疯狂的项目经理 · ${title}`, `Crazy Project Manager · ${title}`);
    }
    renderRole();
    renderScores(version);
    renderRoundNeeds(version);
    renderCanvas();
    renderJob();
    renderCaption();
    renderChat();
    renderDraftControls();
    renderMeetingControls();
    renderComposerTarget();
    sheets.refresh();
    const initial = !session;
    for (const id of ['briefBtn', 'toolTraceBtn']) if (find(id)) find(id).disabled = initial;
    for (const id of ['replayBtn', 'finalizeBtn', 'exportBtn', 'historyBtn']) {
      const control = find(id);
      if (control) control.disabled = !version;
    }
    const artwork = Boolean(version || visibleDraft(null));
    find('previewTab').disabled = !artwork;
    find('uploadBtn').disabled = !artwork;
    const materials = find('importMaterialBtn');
    if (materials) materials.disabled = !artwork;
    employeeMic.disabled = !session;
    if (!initial) schedulePresentedState(version);
  }

  function schedulePresentedState(version) {
    const view = {
      selectedRole: currentRole, selectedVersionId: version?.id, versionId: version?.id,
      draftId: visibleDraft(version)?.id ?? null,
      job: session.job, finalizedVersionId: session.finalizedVersionId, slaps: session.slaps,
      issueCount: (version?.issues ?? session.issues ?? []).filter((item) => item.status !== 'resolved').length,
      scores: Object.fromEntries(clients.map((role) => [role, scoreText(version?.review?.[role])])),
      awaitingRole: session.awaitingRole, mode: session.mode
    };
    const signature = JSON.stringify(view);
    if (signature === presentedKey) return;
    presentedKey = signature;
    cancelAnimationFrame(stateFrame);
    const owner = recorder;
    stateFrame = requestAnimationFrame(() => owner?.record('ui.state', view));
  }

  function resetPlayback() {
    playbackGeneration += 1;
    speakingQueue = [];
    clearTimeout(deskCaptionTimer);
    deskCaption = null;
    designerStreams.clear();
    retiredDesignerTurns.clear();
    stage.stop('session-change');
    hideBreakout();
    castAnnouncements.textContent = '';
    bufferedClientTurns.clear();
    speechFailures.clear();
    meetingStreams.clear();
    retiredMeetingTurns.clear();
    historyByRole.clear();
    needsByRole.clear();
    legacyNeedsViews.clear();
    speechRunning = false;
    startedSpeechId = null;
    soundBlocked = null;
    meetingHold = null;
    changingMeetingMode = false;
    meetingApprovalChange = null;
    releasingMeeting = null;
    reviewingFeedback = null;
    pendingFeedbackKey = '';
    liveTranscript = null;
    voiceActive = false;
    employeeMic.dataset.recording = 'false';
    retryingRound = null;
    renderEmployeeSpeechFailure();
    remoteReviewTurn = presentedReviewTurn = null;
    employeeTurn = null;
    shownEmployeeTurn = null;
  }

  function bufferClientTurn(turn, versionId = turn?.versionId, holdNeeds = true) {
    if (!turn?.id || turn.mode === 'local' || !clients.includes(turn.role)) return;
    const preceding = remoteReviewTurn?.role === turn.role && remoteReviewTurn.roundId === turn.roundId ? remoteReviewTurn : null;
    bufferedClientTurns.set(turn.id, { role: turn.role, versionId, roundId: turn.roundId, phase: 'preparing', holdNeeds });
    if (preceding) remoteReviewTurn = null;
  }

  function discardMeetingTurn(turnId) {
    if (!turnId || retiredMeetingTurns.get(turnId) === 'cancelled') return;
    meetingStreams.delete(turnId);
    retiredMeetingTurns.set(turnId, 'cancelled');
    const discarded = speakingQueue.filter(turn => turn.meetingTurnId === turnId);
    if (discarded.includes(speakingQueue[0])) {
      speechPause += 1;
      stage.stop('meeting-interjection');
    }
    speakingQueue = speakingQueue.filter(turn => turn.meetingTurnId !== turnId);
    for (const turn of discarded) {
      bufferedClientTurns.delete(turn.id);
      speechFailures.delete(turn.id);
      if (soundBlocked === turn.id) soundBlocked = null;
      if (presentedReviewTurn?.id === turn.id) presentedReviewTurn = null;
    }
    for (const [id, failure] of speechFailures) if (failure.turn.meetingTurnId === turnId) speechFailures.delete(id);
    stage.discardTurns?.(discarded.map(turn => turn.id));
    if (remoteReviewTurn?.turnId === turnId) remoteReviewTurn = null;
  }

  function acceptMeetingSpeech({ sessionId, roundId, versionId, turnId, role, index, text, chunkId }) {
    if (sessionId !== session?.id || !clients.includes(role) || !turnId || retiredMeetingTurns.has(turnId) ||
      !Number.isSafeInteger(index) || index < 0 || typeof text !== 'string' || !text.trim()) return;
    let stream = meetingStreams.get(turnId);
    if (!stream) {
      stream = { roundId, versionId, role, parts: new Map() };
      meetingStreams.set(turnId, stream);
    }
    if (stream.parts.has(index)) return;
    const clientCue = !stream.parts.size ? 'desk' : followsSentence(stream.parts.get(index - 1), text) ? 'accent' : null;
    stream.parts.set(index, text);
    const turn = { id: chunkId || `${turnId}:${index}`, meetingTurnId: turnId, role, text, speech: text, mode: 'online', roundId, versionId, clientCue };
    bufferClientTurn(turn, versionId, false);
    renderRoundNeeds(getVersion());
    playTurns([turn]);
  }

  function finalMeetingSpeech(turn) {
    const turnId = turn.turnId;
    if (!turnId) return [turn];
    if (retiredMeetingTurns.has(turnId)) return [];
    const stream = meetingStreams.get(turnId);
    meetingStreams.delete(turnId);
    retiredMeetingTurns.set(turnId, 'finished');
    if (!stream?.parts.size) return [{ ...turn, meetingTurnId: turnId }];
    const text = turn.speech || turn.text;
    if (typeof text !== 'string') return [];
    return (missingSpeech(text, stream.parts) ?? []).map(({ text: speech, clientCue }, index) =>
      ({ ...turn, id: `${turnId}:gap:${index}`, meetingTurnId: turnId, text: speech, speech, clientCue }));
  }

  function acceptDesignerSpeech({ sessionId, jobId, turnId, chunkId, index, text, role, versionId }) {
    if (sessionId !== session?.id || role !== 'yi' || !jobId || !turnId || retiredDesignerTurns.has(turnId) ||
      !Number.isSafeInteger(index) || index < 0 || session.messages?.some(message => message.role === 'yi' && message.turnId === turnId)) return;
    const speech = designerSpeech(text);
    if (!speech) return;
    let stream = designerStreams.get(turnId);
    if (!stream) {
      stream = { id: turnId, jobId, parts: new Map() };
      designerStreams.set(turnId, stream);
    }
    if (stream.jobId !== jobId || stream.parts.has(index)) return;
    stream.parts.set(index, speech);
    stream.text = [...stream.parts.entries()].sort(([first], [second]) => first - second).map(([, part]) => part).join(' ');
    const turn = { id: chunkId || `${turnId}:${index}`, designerTurnId: turnId, jobId, role, mood: 'ready',
      kind: 'designer-progress', mode: 'online', text: speech, speech, versionId: versionId ?? session.job?.baseVersionId };
    stream.latest = turn;
    renderChat();
    renderCaption();
    playTurns([turn]);
  }

  function finalDesignerSpeech(turn) {
    const turnId = turn.turnId;
    if (turnId && retiredDesignerTurns.has(turnId)) return [];
    const stream = designerStreams.get(turnId);
    if (turnId) {
      designerStreams.delete(turnId);
      retiredDesignerTurns.add(turnId);
    }
    const text = designerSpeech(turn.speech || turn.text);
    if (!text) return [];
    if (!stream?.parts.size) return [{ ...turn, text, speech: text }];
    const missing = missingSpeech(text, stream.parts);
    return (missing ?? []).map(({ text: speech }, index) => ({
      ...turn, id: `${turnId}:gap:${index}`, designerTurnId: turnId, text: speech, speech,
    }));
  }

  function playTurns(turns, { retry = false, urgent = false } = {}) {
    if (!Array.isArray(turns) || !turns.length) return;
    const pending = new Set(speakingQueue.map((turn) => turn.id));
    const added = [];
    for (const turn of turns) {
      if (turn.mode === 'local' || (!retry && turn.id && pending.has(turn.id))) continue;
      if (turn.id) pending.add(turn.id);
      added.push(turn);
    }
    if (!added.length) return;
    if (urgent) {
      const head = speakingQueue[0];
      const freeHead = speechRunning && head && startedSpeechId !== head.id && !meetingHold && !soundBlocked && head.kind !== 'desk-reaction';
      if (freeHead) {
        speechPause += 1;
        stage.stop('desk-reaction');
      }
      const after = speechRunning && !freeHead && !meetingHold && !soundBlocked ? 1 : 0;
      const firstRegular = speakingQueue.findIndex((turn, index) => index >= after && turn.kind !== 'desk-reaction');
      speakingQueue.splice(firstRegular < 0 ? speakingQueue.length : firstRegular, 0, ...added);
    } else {
      speakingQueue.push(...added);
    }
    stage.prepareTurns(added);
    kickSpeech();
  }

  function kickSpeech() {
    if (!speechRunning && !meetingHold && !soundBlocked && speakingQueue.length) void runSpeech();
  }

  async function runSpeech() {
    const run = playbackGeneration;
    speechRunning = true;
    try {
      while (run === playbackGeneration && !meetingHold && !soundBlocked && speakingQueue.length) {
        const turn = speakingQueue[0];
        startedSpeechId = null;
        const pause = speechPause;
        try {
          await stage.play([turn]);
        } catch {
          if (run === playbackGeneration && pause === speechPause) showSpeechFailure(turn, 'unavailable');
        }
        if (run !== playbackGeneration) return;
        if (pause !== speechPause || soundBlocked === turn.id) continue;
        if (speakingQueue[0] === turn) speakingQueue.shift();
        if (presentedReviewTurn?.id === turn.id) presentedReviewTurn = null;
        if (!speakingQueue.some(queued => queued.id === turn.id)) bufferedClientTurns.delete(turn.id);
        renderRoundNeeds(getVersion());
      }
    } finally {
      if (run === playbackGeneration) {
        speechRunning = false;
        startedSpeechId = null;
      }
    }
  }

  function pendingDiscussion() {
    const version = getVersion();
    if (!version) return [];
    const round = reviewRound(version);
    if (round) {
      const messages = (session.messages ?? []).filter((message) => message.roundId === round.id && clients.includes(message.role));
      if (messages.length || round.status !== 'completed') return messages;
    }
    const current = (session?.lastDialogue ?? []).filter((message) =>
      clients.includes(message.role) && (!message.versionId || message.versionId === version?.id));
    if (current.length > 1) return current;
    const matchingReview = (session?.messages ?? []).filter((message) =>
      message.versionId === version?.id && clients.includes(message.role) &&
      ['review', 'rebuttal', 'opening'].includes(message.kind));
    if (matchingReview.length) return matchingReview.slice(-5);
    if (current.length) return current;
    return clients.map((role) => session?.messages?.findLast((message) => message.role === role)).filter(Boolean);
  }

  function acceptUpdate(snapshot, events, { playback = false } = {}) {
    if (!session) return;
    const changed = snapshot?.id === session.id && Number(snapshot.seq) > Number(session.seq);
    const meeting = (changed ? snapshot.meetingMode : session.meetingMode) !== false;
    if (changed) {
      for (const message of snapshot.messages ?? []) {
        if (message.kind === 'meeting-interjection') discardMeetingTurn(message.interruptedTurnId);
      }
    }
    if (changed && !playback) {
      const known = new Set((session.messages ?? []).map(turn => turn.id));
      for (const turn of snapshot.messages ?? []) {
        if (!known.has(turn.id) && !(meeting && turn.turnId) && turn.versionId === snapshot.selectedVersionId &&
          ['opening', 'review', 'rebuttal'].includes(turn.kind)) {
          bufferClientTurn(turn);
        }
      }
    }
    const turns = [];
    const committedDesigner = new Set();
    if (playback) {
      for (const event of [...(events ?? [])].sort((first, second) => first.seq - second.seq)) {
        if (event.seq <= eventFloor) continue;
        eventFloor = event.seq;
        const detail = event.data ?? {};
        if (event.type === 'round-turn-started' && clients.includes(event.role)) {
          if (retiredMeetingTurns.get(detail.turnId) === 'cancelled') continue;
          if (detail.turnId) {
            for (const [turnId, parts] of meetingStreams) {
              if (turnId !== detail.turnId && parts.roundId === detail.roundId && parts.role === event.role) discardMeetingTurn(turnId);
            }
          }
          remoteReviewTurn = { role: event.role, versionId: event.versionId, roundId: detail.roundId, turnId: detail.turnId, phase: 'thinking' };
        } else if (event.type === 'message' && detail.message?.role === 'yi' && designerStreams.has(detail.message.turnId)) {
          committedDesigner.add(detail.message.turnId);
        } else if (event.type === 'dialogue') {
          for (const turn of detail.turns ?? []) {
            if (detail.auto) {
              const progress = turn.kind === 'designer-progress' || designerStreams.has(turn.turnId);
              if (meeting && turn.role === 'yi' && !progress && !(turn.kind === 'job' && turn.mood === 'done')) continue;
              const playable = turn.role === 'yi' ? finalDesignerSpeech(turn) : finalMeetingSpeech(turn);
              if (turn.role === 'yi' && turn.turnId) committedDesigner.add(turn.turnId);
              for (const line of playable) {
                bufferClientTurn(line, line.versionId ?? event.versionId, !meeting);
                turns.push(line);
              }
            } else {
              bufferedClientTurns.delete(turn.id);
              if (turn.turnId) {
                if (turn.role === 'yi') committedDesigner.add(turn.turnId);
                else {
                  meetingStreams.delete(turn.turnId);
                  retiredMeetingTurns.set(turn.turnId, 'finished');
                }
              }
              if (remoteReviewTurn?.role === turn.role && remoteReviewTurn.roundId === turn.roundId) remoteReviewTurn = null;
            }
          }
        } else if (event.type === 'round-turn-passed' && remoteReviewTurn?.turnId === detail.turnId) {
          remoteReviewTurn = null;
        } else if (event.type === 'round-completed' && remoteReviewTurn?.roundId === detail.round?.id) {
          remoteReviewTurn = null;
        } else if (event.type === 'round-review-failed') {
          for (const [turnId, parts] of meetingStreams) {
            if (parts.roundId === detail.roundId && parts.role === (event.role ?? detail.role)) discardMeetingTurn(turnId);
          }
          if (remoteReviewTurn?.roundId === detail.roundId) remoteReviewTurn = null;
        } else if (event.type === 'slap') {
          const origin = detail.source ?? 'remote';
          if (!localNudges.delete(event.commandId) && ['desk', 'button', 'keyboard', 'space'].includes(origin)) {
            deskReaction(origin, event.commandId ?? `remote-${event.seq}`);
          }
        }
      }
    }
    for (const turnId of committedDesigner) {
      designerStreams.delete(turnId);
      retiredDesignerTurns.add(turnId);
    }
    if (changed) {
      const oldVersion = getVersion()?.id;
      session = snapshot;
      if (oldVersion !== getVersion()?.id) {
        camera.located = [];
        camera.base = null;
      }
      render();
    } else if (playback) {
      renderRoundNeeds(getVersion());
      if (committedDesigner.size) {
        renderChat();
        renderCaption();
      }
    }
    playTurns(turns);
    kickSpeech();
  }

  class RequestError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(withLanguage(url), { ...options, headers: { ...(options.headers ?? {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(payload.error ?? t('会话服务暂不可用', 'The session service is temporarily unavailable.'), response.status, payload);
    return payload;
  }

  async function refreshOnlineSetup() {
    const revision = ++settingsRevision;
    try {
      const config = await request('/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (revision !== settingsRevision) return;
      const missing = [];
      if (config.agent?.available === false) missing.push('Agent');
      const voices = config.tts?.activeVoices;
      if (config.tts?.available === false || (Array.isArray(voices) && [...clients, 'yi'].some(role => !voices.includes(role)))) missing.push('TTS');
      const link = find('onlineSetupLink');
      link.hidden = !missing.length;
      link.title = t(`缺少 ${missing.join('、')} 配置`, `Missing ${missing.join(' and ')} settings`);
    } catch {
      // Configuration errors still surface on the affected job or line.
    }
  }

  function attachStream() {
    const id = session.id;
    const url = `/api/sessions/${encodeURIComponent(id)}/events?after=${eventFloor}`;
    stream?.close();
    const source = new EventSource(withLanguage(url));
    stream = source;
    let failed = false;
    source.addEventListener('open', () => {
      if (source !== stream) return;
      if (failed) setNotice('');
      record('session.connection', { state: failed ? 'reconnected' : 'connected' });
      kickSpeech();
    });
    source.addEventListener('error', () => {
      if (source !== stream) return;
      if (!failed) record('session.connection', { state: 'disconnected' });
      failed = true;
      setNotice(t('连接中断，正在重连…', 'Connection lost. Reconnecting…'));
    });
    const update = ({ data }) => {
      if (source !== stream || session?.id !== id) return;
      try {
        const payload = JSON.parse(data);
        acceptUpdate(payload.state, payload.events, { playback: true });
        failed = false;
        setNotice('');
      } catch (error) {
        record('session.connection', { state: 'invalid-update', message: error.message });
      }
    };
    source.addEventListener('update', update);
    source.addEventListener('meeting-speech', ({ data }) => {
      if (source !== stream || session?.id !== id) return;
      try {
        acceptMeetingSpeech(JSON.parse(data));
      } catch (error) {
        record('session.connection', { state: 'invalid-meeting-speech', message: error.message });
      }
    });
    source.addEventListener('designer-speech', ({ data }) => {
      if (source !== stream || session?.id !== id) return;
      try {
        acceptDesignerSpeech(JSON.parse(data));
      } catch (error) {
        record('session.connection', { state: 'invalid-designer-speech', message: error.message });
      }
    });
    source.onmessage = update;
  }

  async function command(type, payload = {}, options = {}) {
    if (!session) return false;
    const sessionId = session.id;
    const id = options.id ?? crypto.randomUUID();
    const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/commands`;
    const body = JSON.stringify({ id, type, payload });
    const key = options.singleFlight ? type : id;
    if (posting.has(key)) return false;
    posting.add(key);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await request(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(8500) });
          if (session?.id !== sessionId) return false;
          acceptUpdate(result.state);
          return result.result ?? true;
        } catch (error) {
          if (attempt === 0 && (error.status == null || error.status >= 500)) {
            record('session.connection', { state: 'retry-command', commandId: id, type });
            continue;
          }
          if (session?.id === sessionId) {
            acceptUpdate(error.data?.state);
            toast(error instanceof RequestError ? error.message : t('发送失败，连接恢复后可重试。', 'Send failed. Try again when the connection is back.'), 'error');
            record('ui.command-error', { commandId: id, type, status: error.status ?? null, message: error.message });
          }
        }
      }
      return false;
    } finally {
      posting.delete(key);
    }
  }

  async function changeSession(id, { intro = false } = {}) {
    if (opening) return false;
    opening = true;
    const ticket = ++generation;
    try {
      const initial = await request(`/api/sessions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(9000) });
      if (ticket !== generation) return false;
      const next = initial.state ?? initial;
      if (!next.id || !Array.isArray(next.versions)) throw new Error(t('没有收到有效的会话数据。', 'Could not read the project data.'));
      if (session) {
        posterFullscreen?.close();
        sheets.reset();
        resetPlayback();
        stage.cancelMic?.('session-change');
        stream?.close();
        const outgoing = recorder;
        if (outgoing) Promise.resolve(outgoing.flush()).catch(() => {}).finally(() => outgoing.close());
      }
      session = next;
      deskHits = Number.isSafeInteger(next.slaps) ? next.slaps : 0;
      recorder = createRecorder({ sessionId: next.id, getContext });
      eventFloor = Number(next.seq) || 0;
      localNudges.clear();
      camera = { zoom: 1, comparing: false, base: null, located: [] };
      chatKey = scoresKey = needsKey = artKey = canvasKey = elementKey = jobKey = presentedKey = '';
      chat.replaceChildren();
      drafts = readStored(draftKey(next.id), { employee: '' });
      const openingTurns = intro ? pendingDiscussion() : [];
      for (const turn of openingTurns) bufferClientTurn(turn);
      render();
      void stage.prepareDeskReaction(deskTurn(deskHits));
      setNotice('');
      if (next.language !== language) await command('setLanguage', { language });
      attachStream();
      const recording = recorder;
      requestAnimationFrame(() => recording?.record('ui.ready', { restored: Boolean(id), appearance: 'manga-2' }));
      playTurns(openingTurns);
      return true;
    } catch (error) {
      if (session) toast(error.message || t('无法打开会话。', 'Could not open the session.'), 'error');
      else if (!(id && error.status === 404)) {
        setNotice(t('无法加载项目，刷新页面可重试。', 'Could not load the project. Refresh to try again.'));
      }
      return !session && id && error.status === 404 ? 'missing' : false;
    } finally {
      opening = false;
    }
  }

  function selectRole(role) {
    if (clientCards.dataset.expandedRole !== role) {
      clientCards.dataset.expandedRole = role;
      refreshBreakoutPosition();
      record('ui.actor-expand', { role });
    }
    record('ui.selection', { role });
    return command('selectRole', { role });
  }

  async function selectVersion(versionId) {
    if (!versionId || getVersion()?.id === versionId) return true;
    record('ui.selection', { versionId });
    return command('selectVersion', { versionId });
  }

  async function continueDraft() {
    const draft = session?.draft;
    if (!draft || (!visibleDraft() && !(await selectVersion(draft.baseVersionId)))) return;
    if (!visibleDraft()) return;
    if (camera.comparing) setCompare(false);
    employeeInput.focus();
  }

  async function applyDraft(type, draftId) {
    const sessionId = session?.id;
    const confirming = type === 'confirmDraft';
    const first = session?.draft?.baseVersionId === null;
    if (!draftId || session?.draft?.id !== draftId || (confirming && !visibleDraft()) ||
      draftAction?.sessionId === sessionId || editingStatuses.includes(session?.job?.status)) return false;
    const action = { sessionId, type };
    draftAction = action;
    renderDraftControls();
    try {
      const result = await command(type, { draftId }, { singleFlight: true });
      if (!result || session?.id !== sessionId) return false;
      if (camera.comparing) setCompare(false);
      if (confirming) {
        const versionId = result.versionId ?? getVersion()?.id;
        toast(first ? t(`已发布 ${versionId}`, `Published ${versionId}`) : t(`已生成 ${versionId}`, `Created ${versionId}`));
      } else {
        toast(t('已放弃草稿。', 'Draft discarded.'));
      }
      return true;
    } finally {
      if (draftAction === action) draftAction = null;
      renderDraftControls();
    }
  }

  function setCompare(comparing) {
    const draft = visibleDraft();
    if (comparing && (!getVersion() || (!draft && session.versions.length < 2))) return;
    if (comparing && !camera.comparing && draft) camera.base = draft.baseVersionId;
    camera.comparing = comparing;
    if (!comparing) camera.located = [];
    renderCanvas();
    record('ui.compare', { comparing, baseVersionId: camera.base });
  }

  async function locate(elementIds, versionId) {
    if (versionId && versionId !== getVersion()?.id && !(await selectVersion(versionId))) return;
    if (camera.comparing) setCompare(false);
    camera.located = elementIds.filter(id => id !== '$canvas');
    renderElements();
    record('ui.locate', { elementIds: camera.located, versionId: getVersion()?.id });
    if (matchMedia('(max-width: 650px)').matches) {
      artboard.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    if (camera.zoom > 1) find('elementOverlay').firstElementChild?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }

  function setZoom(value) {
    const old = Math.max(camera.zoom, .1);
    camera.zoom = Math.max(.65, Math.min(2.2, Math.round(value * 100) / 100));
    renderCanvas();
    artboard.scrollLeft = Math.max(0, (artboard.scrollLeft + artboard.clientWidth / 2) * camera.zoom / old - artboard.clientWidth / 2);
    artboard.scrollTop = Math.max(0, (artboard.scrollTop + artboard.clientHeight / 2) * camera.zoom / old - artboard.clientHeight / 2);
    record('ui.zoom', { zoom: camera.zoom });
  }

  async function sendAssignment(text, config = {}) {
    const versionId = config.baseVersionId ?? getVersion()?.id;
    const instruction = text.trim();
    if ((!versionId && !visibleDraft(null)) || !instruction) return false;
    const source = config.source ?? 'text';
    const links = source === 'text' ? assignmentImageLinks(instruction) : [];
    if (!links.length && editingStatuses.includes(session?.job?.status) &&
      /继续|复工|接着|别摸鱼|别偷懒|醒醒|赶紧|快点|快一点|进度|\b(?:keep going|resume|hurry up|wake up|back to work|stop slacking)\b/i.test(text) && !['quote', 'merged', 'edited', 'shortcut'].includes(source)) {
      return command('nudge', { source, text: instruction });
    }
    const sessionId = session?.id;
    const materials = new Set();
    try {
      for (const link of links) {
        if (session?.id !== sessionId) return false;
        materials.add((await importMaterial(link)).materialId);
      }
    } catch (error) {
      if (session?.id === sessionId) toast(error.message, 'error');
      return false;
    }
    if (session?.id !== sessionId) return false;
    const materialIds = [...materials];
    const appended = materialIds.length ? `\n${t(`已导入图片素材 ${materialIds.join('、')}`, `Imported image materials ${materialIds.join(', ')}`)}` : '';
    return command('assign', {
      text: instruction + appended, sourceIds: config.sourceIds ?? [], baseVersionId: versionId ?? null, source,
      ...(materialIds.length ? { materialIds } : {})
    });
  }

  function deskTurn(index, commandId) {
    const slot = index % deskReactions.length;
    const state = editingStatuses.includes(session?.job?.status) ? 'atWork' : 'idle';
    const text = t(deskReactions[slot][state], englishDeskReactions[slot][state]);
    return { id: commandId ? `desk:${commandId}` : null, role: 'yi', text, mood: 'startled', kind: 'desk-reaction',
      mode: 'online', versionId: getVersion()?.id };
  }

  function deskReaction(source, commandId) {
    const turn = deskTurn(deskHits++, commandId);
    const impact = stage.slap({ source });
    deskCaption = turn;
    renderCaption();
    clearTimeout(deskCaptionTimer);
    deskCaptionTimer = setTimeout(() => {
      deskCaption = null;
      renderCaption();
    }, 1400);
    if (preferences.muted) return;
    if (soundBlocked) {
      speechPause += 1;
      soundBlocked = null;
      renderMeetingControls();
    }
    playTurns([{ ...turn, impact }], { urgent: true });
    void stage.prepareDeskReaction(deskTurn(deskHits));
  }

  function physicalNudge(source) {
    if (!session) return;
    const id = crypto.randomUUID();
    localNudges.add(id);
    if (localNudges.size > 80) localNudges.delete(localNudges.values().next().value);
    deskReaction(source, id);
    void command('nudge', { source }, { id });
  }

  function finishVoiceComposition(capture, unsent = '') {
    if (liveTranscript !== capture) return;
    liveTranscript = null;
    voiceActive = false;
    employeeMic.dataset.recording = 'false';
    if (unsent.trim()) {
      const previous = drafts.meeting?.roundId === capture.roundId && drafts.meeting?.versionId === capture.versionId ? drafts.meeting?.text : '';
      setMeetingDraft(previous && previous !== unsent ? `${previous}\n${unsent}` : unsent, capture);
    }
    releaseMeetingFloor(capture.hold);
    renderComposerTarget();
    renderMeetingControls();
  }

  function renderVoiceStatus({ state, role, text, error, recordingId, recognitionMode }) {
    if (state === 'starting' && session) {
      const hold = meetingHold;
      liveTranscript = { recordingId, role, hold, owner: session.id, roundId: hold?.roundId,
        versionId: hold?.versionId ?? getVersion()?.id, text: '', sending: false };
    }
    const capture = liveTranscript;
    if (!capture || capture.recordingId !== recordingId || capture.owner !== session?.id) return;
    if (state === 'error') {
      finishVoiceComposition(capture, text?.trim() || capture.text);
      toast(error || t('语音未识别，请继续打字。', 'Could not recognize the recording. You can type instead.'), 'error');
      return;
    }
    if (state === 'idle') {
      queueMicrotask(() => { if (!capture.sending) finishVoiceComposition(capture); });
      return;
    }
    const hold = t('按住说话', 'Hold to talk');
    const sentence = recognitionMode === 'volcengine-sentence';
    const labels = { starting: t('正在启动', 'Starting'),
      recording: sentence ? t('松手转写', 'Release to transcribe') : t('松手发送', 'Release to send'),
      processing: sentence ? t('正在转写整句', 'Transcribing the sentence') : t('正在转写', 'Transcribing'),
    };
    voiceActive = Object.hasOwn(labels, state);
    employeeMic.dataset.recording = String(state === 'recording');
    employeeMic.querySelector('span').textContent = labels[state] ?? hold;
    if (typeof text === 'string') capture.text = text;
    renderComposerTarget();
    renderMeetingControls();
  }

  function takeMeetingFloor(target = { roundId: meetingMode() ? currentMeetingRound()?.id : undefined, versionId: getVersion()?.id }) {
    if (!session) return null;
    const capture = { owner: session.id, roundId: target.roundId, versionId: target.versionId };
    meetingHold = capture;
    speechPause += 1;
    const turn = speakingQueue[0];
    if (turn && !bufferedClientTurns.has(turn.id)) bufferClientTurn(turn, turn.versionId, false);
    stage.stop('meeting-interjection');
    renderMeetingControls();
    renderRoundNeeds(getVersion());
    return capture;
  }

  function releaseMeetingFloor(capture) {
    if (!capture || meetingHold !== capture) return;
    meetingHold = null;
    renderMeetingControls();
    renderRoundNeeds(getVersion());
    kickSpeech();
  }

  async function sendInterjection(text, target, capture) {
    if (!session || !text.trim()) return false;
    const hold = capture ?? takeMeetingFloor(target);
    const { roundId, versionId } = hold;
    if (hold) hold.sending = true;
    try {
      const result = await command('meetingInterject', { text: text.trim(), source: 'voice',
        ...(roundId && { roundId }), ...(versionId && { versionId }),
      }, { singleFlight: true });
      if (result && session?.id === hold?.owner) {
        toast(result.deferred ? t('语音已加入小乙的队列。', 'Voice instruction queued for Xiao Yi.')
          : t('已发送给小乙', 'Sent to Xiao Yi'));
      }
      return result;
    } finally {
      releaseMeetingFloor(hold);
    }
  }

  async function receiveTranscript({ text, recordingId }) {
    const capture = liveTranscript;
    const transcript = text?.trim();
    if (!capture || capture.recordingId !== recordingId || capture.owner !== session?.id || capture.sending || !transcript) return;
    capture.text = transcript;
    capture.sending = true;
    renderComposerTarget();
    let sent = false;
    try {
      sent = await sendInterjection(transcript, capture, capture.hold);
    } finally {
      finishVoiceComposition(capture, sent ? '' : transcript);
    }
  }

  function beforeRecord() {
    if (!session || liveTranscript || find('chatForm').getAttribute('aria-busy') === 'true') return false;
    if (readStored(`crazy-pm.recording.${session.id}`, false)) {
      takeMeetingFloor();
      return true;
    }
    sheets.recordingNotice();
    return false;
  }

  async function downloadVersion(versionId, format) {
    const result = await command('export', { versionId, format }, { singleFlight: true });
    if (!result || result === true || !result.url) return false;
    const url = new URL(result.url, location.href);
    if (url.origin !== location.origin) return false;
    const link = node('a', { attrs: { href: url.href, download: result.fileName ?? `${versionId}.${format}` } });
    document.body.append(link);
    link.click();
    link.remove();
    toast(t(`${versionId} ${format.toUpperCase()} 已导出`, `${versionId} ${format.toUpperCase()} exported`));
    return true;
  }

  async function rasterize(file, { png = false } = {}) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalHeight || !image.naturalWidth) throw new Error(t('无法读取图片尺寸。', 'Could not read the image dimensions.'));
      const canvas = document.createElement('canvas');
      function draw(maxSize) {
        const ratio = Math.min(1, maxSize / Math.max(image.naturalHeight, image.naturalWidth));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      draw(1600);
      const data = canvas.toDataURL('image/png');
      if (data.length < 6500000) return data;
      if (!png) return canvas.toDataURL('image/webp', .92);
      draw(1000);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function upload(file) {
    if (!session || !file) return;
    const sessionId = session.id;
    if (!file.type.startsWith('image/') || file.size > maxImageBytes) {
      toast(t('请选择 24 MB 以内的图片。', 'Choose an image under 24 MB.'), 'error');
      return;
    }
    try {
      const data = await rasterize(file);
      if (session?.id !== sessionId) return;
      record('ui.upload', { name: file.name, selectedBytes: file.size, contentType: file.type });
      if (await command('upload', { data, name: file.name }, { singleFlight: true })) {
        toast(t('主视觉已加入待确认草稿。', 'Artwork added to the draft for approval.'));
      }
    } catch {
      toast(t('无法读取这张图片。', 'Could not read this image.'), 'error');
    }
  }

  function imageType(path) {
    return imageExtensions.get(path.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase());
  }

  function validImageUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function assignmentImageLinks(text) {
    const matches = [...text.matchAll(/https?:\/\/[^\s<>"'，。；！？、）】]+/gi)];
    const importImage = /(?:导入|添加|插入|放入|载入|使用|下载).{0,16}(?:图片|图像|照片|配图|图层|素材)|\b(?:import|insert|add|place|use|load|download)\b.{0,30}\b(?:image|picture|photo|artwork)\b/i;
    const reservation = /(?:预约|购票|报名)(?:页|平台)?(?:网址|链接)|\b(?:booking|reservation|sign-up|ticketing) (?:url|link)\b/i;
    const separator = /[\n，。；！？;]/;
    const links = new Set();
    for (const match of matches) {
      const url = validImageUrl(match[0].replace(/[),.;!?]+$/, ''));
      if (!url) continue;
      const before = text.slice(0, match.index).split(separator).at(-1);
      const after = text.slice(match.index + match[0].length).split(separator)[0];
      const context = `${before.slice(-70)} ${after.slice(0, 50)}`;
      if (reservation.test(context) && !importImage.test(context)) continue;
      const type = imageType(url.pathname);
      if ((type && type !== 'image/svg+xml') || importImage.test(context) || (matches.length === 1 && !reservation.test(text) && importImage.test(text))) {
        links.add(url.href);
      }
    }
    return [...links];
  }

  async function readLinkedImage(value, signal) {
    const url = validImageUrl(value);
    if (!url) throw new Error(t('请输入有效的 HTTP 或 HTTPS 图片链接。', 'Enter a valid HTTP or HTTPS image URL.'));
    const timeout = AbortSignal.timeout(15000);
    const sizeError = t('请选择 24 MB 以内的图片。', 'Choose an image under 24 MB.');
    try {
      const response = await fetch(url, {
        mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok || !response.body) throw new Error(t('图片链接无法访问。可改用本机图片。', 'This URL is unavailable. You can import an image file instead.'));
      if (Number(response.headers.get('content-length')) > maxImageBytes) throw new Error(sizeError);
      const source = validImageUrl(response.url) ?? url;
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const type = mime?.startsWith('image/') ? mime : (!mime || mime === 'application/octet-stream') ? imageType(source.pathname) ?? imageType(url.pathname) : null;
      if (!type) throw new Error(t('此链接未返回图片。可改用本机图片。', 'This URL returned a different file type. You can import an image file instead.'));
      const reader = response.body.getReader();
      const parts = [];
      let total = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
          if (total > maxImageBytes) {
            void reader.cancel().catch(() => {});
            throw new Error(sizeError);
          }
          parts.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
      const name = source.pathname.split('/').at(-1);
      let label = name;
      try { label = decodeURIComponent(name); } catch { /* Keep a URL name with invalid escapes. */ }
      return { file: new Blob(parts, { type }), name: label, sourceUrl: `${url.origin}${url.pathname}` };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof TypeError || timeout.aborted) {
        throw new Error(t('无法读取图片链接。请使用允许跨域的链接，或选择本机图片。', 'The browser could not read this URL. Use a link that allows cross-origin access or choose an image file.'));
      }
      throw error;
    }
  }

  async function importMaterial(source, signal) {
    const sessionId = session?.id;
    if (!sessionId) throw new Error(t('请先打开项目。', 'Open a project first.'));
    const material = typeof source === 'string' ? await readLinkedImage(source, signal) : { file: source, name: source.name };
    const { file, sourceUrl } = material;
    const name = material.name?.replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || t('链接图片', 'Linked image');
    const type = file.type || imageType(name);
    if (!type?.startsWith('image/') || !file.size || file.size > maxImageBytes) {
      throw new Error(t('请选择 24 MB 以内的图片。', 'Choose an image under 24 MB.'));
    }
    let data;
    try {
      data = await rasterize(file.type ? file : file.slice(0, file.size, type), { png: true });
    } catch {
      throw new Error(t('无法读取这张图片。', 'Could not read this image.'));
    }
    signal?.throwIfAborted();
    if (session?.id !== sessionId) throw new Error(t('项目已切换，请重新导入。', 'The project changed. Import the image again.'));
    record('ui.import-material', { name, selectedBytes: file.size, contentType: type, source: sourceUrl ? 'url' : 'file' });
    const result = await command('importMaterial', { data, name, ...(sourceUrl ? { sourceUrl } : {}) }, { singleFlight: true });
    if (!result?.materialId) throw new Error(t('素材导入失败，请重试。', 'The material could not be imported. Try again.'));
    return { materialId: result.materialId, name: result.name ?? name };
  }

  function prepareMaterial(id) {
    if (!session || !id) return;
    const line = t(`把素材 ${id} 添加到海报右上角`, `Place material ${id} in the upper right.`);
    const draft = (drafts.employee ?? '').trimEnd();
    if (!draft.includes(line)) setEmployeeDraft(draft ? `${draft}\n${line}` : line, 'material');
    employeeInput.focus();
  }

  function trackScroll(target, name) {
    let timer;
    target.addEventListener('scroll', () => {
      clearTimeout(timer);
      const currentRecorder = recorder;
      timer = setTimeout(() => {
        const source = target === document ? document.scrollingElement : target;
        currentRecorder?.record('ui.scroll', { target: name, x: source?.scrollLeft ?? 0, y: source?.scrollTop ?? 0 });
      }, 90);
    }, { passive: true });
  }

  function initEventHandlers() {
    for (const element of roleButtons) element.addEventListener('click', () => selectRole(element.dataset.role));
    find('meetingModeBtn').addEventListener('click', async () => {
      if (!session || changingMeetingMode || meetingHold || liveTranscript) return;
      changingMeetingMode = true;
      const enabled = !meetingMode();
      renderMeetingControls();
      try {
        if (await command('setMeetingMode', { enabled }, { singleFlight: true })) record('ui.toggle', { name: 'meetingMode', value: enabled });
      } finally {
        changingMeetingMode = false;
        renderMeetingControls();
      }
    });
    find('meetingApprovalToggle').addEventListener('click', async () => {
      if (!session || !meetingMode() || changingMeetingMode || meetingApprovalChange) return;
      const change = { owner: session.id };
      const required = session.meetingApprovalRequired !== true;
      meetingApprovalChange = change;
      renderMeetingControls();
      try {
        if (await command('setMeetingApproval', { required }, { singleFlight: true }) && session?.id === change.owner) {
          record('ui.toggle', { name: 'meetingApprovalRequired', value: required });
        }
      } finally {
        if (meetingApprovalChange === change) meetingApprovalChange = null;
        renderMeetingControls();
      }
    });
    find('releaseMeetingBtn')?.addEventListener('click', async () => {
      const round = pendingMeetingRound();
      if (session?.meetingApprovalRequired !== true || !round?.assignmentPending || round.releaseRequested || releasingMeeting || reviewingFeedback) return;
      const release = { owner: session.id, roundId: round.id };
      releasingMeeting = release;
      renderMeetingControls();
      try {
        if (await command('releaseMeetingAssignment', { roundId: round.id }, { singleFlight: true }) && session?.id === release.owner) {
          record('ui.meeting-release', { roundId: round.id });
        }
      } finally {
        if (releasingMeeting === release) releasingMeeting = null;
        renderMeetingControls();
      }
    });
    find('soundEnableBtn').addEventListener('click', enableSound);
    find('cancelMeetingDraft')?.addEventListener('click', clearMeetingDraft);
    find('toolTraceBtn')?.addEventListener('click', sheets.traces);
    find('importMaterialBtn')?.addEventListener('click', sheets.materials);
    find('continueDraftBtn')?.addEventListener('click', continueDraft);
    find('confirmDraftBtn')?.addEventListener('click', () => { void applyDraft('confirmDraft', visibleDraft()?.id); });
    find('discardDraftBtn')?.addEventListener('click', () => {
      const draft = session?.draft;
      if (draft) sheets.discardDraft(draft);
    });
    find('resolveConflict').addEventListener('click', () => sheets.feedback('issues'));
    find('historyBtn').addEventListener('click', sheets.versions);
    find('briefBtn').addEventListener('click', sheets.brief);
    find('finalizeBtn').addEventListener('click', sheets.finalize);
    find('exportBtn').addEventListener('click', sheets.exportVersion);
    find('replayBtn').addEventListener('click', async () => {
      if (!session) return;
      stage.pauseMusic(true);
      try {
        await showReplay({ sessionId: session.id, recorder });
        const dialog = document.querySelector('dialog.replay-dialog[open]');
        if (dialog) {
          dialog.addEventListener('close', () => stage.pauseMusic(false), { once: true });
          return;
        }
      } catch (error) {
        toast(error?.message || t('回放加载失败。', 'Could not load the replay.'), 'error');
      }
      stage.pauseMusic(false);
    });

    find('previewTab').addEventListener('click', () => setCompare(false));
    find('compareTab').addEventListener('click', () => setCompare(true));
    document.querySelector('.canvas-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const toCompare = (event.key === 'End' || (event.key !== 'Home' && event.target.id === 'previewTab')) &&
        !find('compareTab').disabled;
      setCompare(toCompare);
      find(toCompare ? 'compareTab' : 'previewTab').focus();
    });
    find('compareVersion').addEventListener('change', (event) => {
      camera.base = event.currentTarget.value;
      renderCanvas();
      record('ui.compare', { comparing: true, baseVersionId: camera.base });
    });
    find('zoomOut').addEventListener('click', () => setZoom(camera.zoom - .15));
    find('zoomIn').addEventListener('click', () => setZoom(camera.zoom + .15));
    find('fitBtn').addEventListener('click', () => setZoom(1));
    find('posterWrap').addEventListener('click', () => {
      if (!camera.located.length) return;
      camera.located = [];
      renderElements();
      record('ui.locate', { elementIds: [], versionId: getVersion()?.id });
    });

    find('uploadBtn').addEventListener('click', () => find('uploadInput').click());
    find('uploadInput').addEventListener('change', (event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      void upload(file);
    });
    find('slapBtn').addEventListener('click', () => physicalNudge('button'));
    find('deskHit').addEventListener('click', () => physicalNudge('desk'));
    find('retryJob').addEventListener('click', () => {
      const jobId = session?.job?.id;
      if (jobId) void command('retry', { jobId }, { singleFlight: true });
    });
    stage.bindMic(employeeMic, { beforeRecord });

    const form = find('chatForm');
    employeeInput.addEventListener('input', () => {
      if (liveTranscript) return;
      if (drafts.meeting) setMeetingDraft(employeeInput.value, drafts.meeting);
      else setEmployeeDraft(employeeInput.value);
    });
    employeeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        record('ui.key', { key: 'Enter', target: employeeInput.id });
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (liveTranscript || form.getAttribute('aria-busy') === 'true') return;
      const sessionId = session?.id;
      const text = employeeInput.value;
      if (!text.trim()) return;
      if (drafts.meeting) {
        const target = drafts.meeting;
        const send = form.querySelector('button[type="submit"]');
        form.setAttribute('aria-busy', 'true');
        send.disabled = true;
        try {
          if (await sendInterjection(text, target) && session?.id === sessionId && drafts.meeting === target) clearMeetingDraft();
        } finally {
          form.removeAttribute('aria-busy');
          renderComposerTarget();
        }
        return;
      }
      if (assignmentImageLinks(text).length) {
        const send = form.querySelector('button[type="submit"]');
        const label = send.textContent;
        send.disabled = true;
        send.textContent = t('导入中…', 'Importing…');
        form.setAttribute('aria-busy', 'true');
        try {
          if (await sendAssignment(text) && employeeInput.value === text && session?.id === sessionId) setEmployeeDraft('', 'send');
        } finally {
          send.disabled = false;
          send.textContent = label;
          form.removeAttribute('aria-busy');
        }
        return;
      }
      setEmployeeDraft('', 'send');
      const okay = await sendAssignment(text);
      if (!okay && !drafts.employee && session?.id === sessionId) setEmployeeDraft(text, 'send-failed');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || event.isComposing || event.defaultPrevented || voiceActive ||
        document.querySelector('dialog[open]') || event.target.closest?.('button, input, textarea, select, .cast-needs, .artboard, [contenteditable=true]')) return;
      event.preventDefault();
      if (event.repeat) return;
      record('ui.key', { key: 'Space', action: 'slap' });
      physicalNudge('keyboard');
    });

    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('button, a, [data-record], #posterWrap');
      if (!target) return;
      record('ui.click', {
        target: target.dataset.record ?? (target.id || target.getAttribute('aria-label') || target.dataset.role || target.textContent.trim().slice(0, 90)),
        x: event.clientX, y: event.clientY, shift: event.shiftKey
      });
    }, true);
    let hovered = null;
    document.addEventListener('pointerover', (event) => {
      const element = event.target.closest?.('[title]');
      const target = element?.dataset.record ?? element?.id ?? '';
      if (!target || element === hovered) return;
      hovered = element;
      record('ui.hover', { target, title: element.title });
    }, { passive: true });
    document.addEventListener('pointerout', (event) => {
      if (hovered && !hovered.contains(event.relatedTarget)) {
        record('ui.hover', { target: hovered.dataset.record ?? hovered.id, open: false });
        hovered = null;
      }
    }, { passive: true });
    const needLists = [...clientCards.querySelectorAll('.cast-needs')].map(panel => [panel, `round-needs:${panel.dataset.needsRole}`]);
    for (const [target, name] of [[artboard, 'artboard'], [chat, 'chat'],
      [clientPanel, 'clients'], ...needLists, [document.querySelector('.agent-panel'), 'employee'],
      [find('modal'), 'dialog'], [document, 'page']]) trackScroll(target, name);
    addEventListener('pagehide', () => { if (recorder) void recorder.flush().catch(() => {}); });
  }

  createScores();
  initEventHandlers();
  applySoundPreferences();
  subscribeAudioPreferences((next, change) => {
    const unmuted = preferences.muted && !next.muted;
    preferences = next;
    applySoundPreferences();
    if (change) record('ui.toggle', change);
    if (change && unmuted) resumeSound();
  });
  render();
  void refreshOnlineSetup();
  addEventListener('focus', refreshOnlineSetup);
  addEventListener('studio-api-settings', refreshOnlineSetup);
  addEventListener('resize', refreshBreakoutPosition);
  addEventListener('scroll', refreshBreakoutPosition, { passive: true });
  clientPanel.addEventListener('scroll', refreshBreakoutPosition, { passive: true });
  const projectLocation = new URL(location.href);
  const projectId = projectLocation.searchParams.get('project');
  function goHome() {
    if (projectLocation.pathname === '/home.html') {
      setNotice(t('项目入口暂时不可用。', 'The project entry point is temporarily unavailable.'));
      return;
    }
    location.replace(withLanguage('/home.html'));
  }
  if (!projectId) {
    goHome();
  } else {
    const intro = projectLocation.searchParams.has('intro');
    const initial = await changeSession(projectId, { intro });
    if (initial === 'missing') goHome();
    else if (initial && intro) {
      projectLocation.searchParams.delete('intro');
      history.replaceState(null, '', projectLocation);
    }
  }
}
