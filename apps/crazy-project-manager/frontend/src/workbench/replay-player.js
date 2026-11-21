const roleNames = {
  zhou: ['周总', 'Director Zhou'], lin: ['林尺', 'Lin Chi'], tang: ['阿唐', 'A-Tang'],
  yi: ['小乙', 'Xiao Yi'], manager: ['项目经理', 'Project manager']
};
const statusNames = {
  working: ['改稿', 'Editing'], running: ['改稿', 'Editing'], queued: ['排队', 'Queued'],
  accepted: ['已接单', 'Accepted'], resumed: ['已复工', 'Resumed'], paused: ['摸鱼', 'Slacking off'],
  completed: ['交稿', 'Delivered'], delivered: ['交稿', 'Delivered'], done: ['完成', 'Complete'],
  failed: ['改稿失败', 'Edit failed'], idle: ['待命', 'On standby'],
  clarification: ['待确认', 'Awaiting clarification'], needs_clarification: ['待确认', 'Awaiting clarification'],
  cancelled: ['已取消', 'Cancelled']
};
const labels = {
  'session-start': ['接项目', 'Started project'], 'role-selected': ['选择收件人', 'Selected recipient'],
  'version-selected': ['切换版本', 'Switched version'], 'job-started': ['派工', 'Assigned work'],
  'job-paused': ['小乙摸鱼', 'Xiao Yi took a break'], 'job-resumed': ['小乙复工', 'Xiao Yi resumed work'],
  'job-completed': ['小乙交稿', 'Xiao Yi delivered the draft'], 'job-clarification': ['小乙回问', 'Xiao Yi asked for clarification'],
  'tool-failed': ['改图失败', 'Poster edit failed'], 'job-retried': ['重试工单', 'Retried assignment'],
  'requirement-status': ['更新需求', 'Updated requirement'], clap: ['拍桌', 'Desk slap'], slap: ['拍桌', 'Desk slap'],
  interrupt: ['打断', 'Interruption'], version: ['出稿', 'Draft ready'], review: ['三方评审', 'Client review'],
  finalized: ['定稿', 'Finalized version'], exported: ['导出海报', 'Exported poster'], uploaded: ['上传图片', 'Uploaded image'],
  'role-fallback': ['本地演练', 'Local rehearsal'], 'qr-checked': ['复核预约码', 'Rechecked booking QR code'],
  'command-rejected': ['操作反馈', 'Action feedback'], 'ui.draft': ['编辑草稿', 'Edited draft'],
  'ui.compare': ['版本对比', 'Compared versions'], 'ui.zoom': ['缩放海报', 'Zoomed poster'],
  'ui.scroll': ['滚动工作台', 'Scrolled the workspace'], 'ui.dialog': ['打开或关闭面板', 'Opened or closed a panel'],
  'ui.toggle': ['切换设置', 'Changed a setting'], 'ui.locate': ['定位图层', 'Located a layer'],
  'session.connection': ['连接变化', 'Connection changed'], 'ui.key': ['快捷键', 'Keyboard shortcut'],
  'ui.hover': ['悬浮提示', 'Hover hint'], 'ui.selection': ['选择', 'Selection'], 'ui.click': ['点击', 'Click'],
  'ui.listen': ['播放评审', 'Played the review'], 'ui.command-error': ['发送失败', 'Action failed to send'],
  'audio-start': ['开始放音', 'Audio started'], 'audio-stop': ['停止放音', 'Audio stopped'],
  'audio-end': ['放音结束', 'Audio finished'], 'recording-start': ['开始录音', 'Recording started'],
  'recording-end': ['结束录音', 'Recording finished'], 'recording-saved': ['录音已保存', 'Recording saved'],
  'subtitle.presented': ['字幕出现', 'Subtitle shown'], 'subtitle-start': ['字幕出现', 'Subtitle shown'],
  'transcript-final': ['语音转写', 'Transcription'], 'impact-start': ['小乙 QAQ', 'Xiao Yi QAQ']
};
const artworkLabels = {
  'manga-cast': ['三位甲方的漫画', 'Client comic art'], 'manga-employee': ['小乙的漫画', 'Xiao Yi’s comic art'],
  'cast-zhou': ['周总的立绘', 'Director Zhou’s portrait'], 'cast-lin': ['林尺的立绘', 'Lin Chi’s portrait'],
  'cast-tang': ['阿唐的立绘', 'A-Tang’s portrait']
};
const panelNames = {
  score: ['评分', 'Score breakdown'], transcript: ['甲方对话', 'Client conversation'],
  forward: ['转交意见', 'Forward feedback'], 'requirement-source': ['原话', 'Original comment'],
  feedback: ['需求与分歧', 'Requirements and disagreements'], versions: ['版本记录', 'Version history'],
  export: ['导出海报', 'Export poster'], finalize: ['定稿', 'Finalize'], brief: ['项目简报', 'Project brief'],
  settings: ['语音设置', 'Audio settings'], 'voice-consent': ['本局录音', 'Session recording'],
  'tool-traces': ['原始工具调用链', 'Raw tool call chains'], materials: ['素材库', 'Materials'],
  'discard-draft': ['放弃草稿', 'Discard draft']
};

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function node(tag, name, value) {
  const element = document.createElement(tag);
  if (name) element.className = name;
  if (value != null) element.textContent = value;
  return element;
}

function upper(items, value) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].time <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function mountReplay(root, bundle) {
  const english = /^en(?:-|$)/i.test(bundle.language ?? document.documentElement.lang);
  const tr = (chinese, englishText) => english ? englishText : chinese;
  const from = (catalog, key) => catalog[key]?.[english ? 1 : 0];
  const roleName = (key) => from(roleNames, key);

  function eventName({ item, type }) {
    if (type === 'version') return `${item.data.version.id} ${item.data.version.label}`;
    if (type === 'exported') return `${tr('导出', 'Exported')} ${item.data.delivery.versionId} ${item.data.delivery.format.toUpperCase()}`;
    if (type === 'message') return `${roleName(item.role) ?? ''} ${item.data.message.text}`;
    return from(labels, type) ?? '';
  }

  const manga = bundle.animation === 'manga-2';
  const castAtlas = manga && bundle.atlases?.cast;
  const employeeAtlas = manga && bundle.atlases?.employee;
  const byVersion = new Map(bundle.versions.map(version => [version.id, version]));
  const hasPresentation = bundle.presentation.some(item => item.type === 'subtitle.presented' || item.type === 'subtitle-start');
  const hasImpact = bundle.presentation.some(item => item.type === 'impact-start');
  const records = [
    ...bundle.events.map(item => ({ item, track: 'business' })),
    ...bundle.presentation.map(item => ({ item, track: 'presentation' }))
  ].map(entry => ({ ...entry, type: entry.item.type, time: Math.max(0, entry.item.at - bundle.startedAt) }))
    .sort((a, b) => a.time - b.time || (a.track === b.track
      ? ((a.item.clientSeq ?? a.item.seq) - (b.item.clientSeq ?? b.item.seq))
      : (a.track === 'business' ? -1 : 1)));
  const total = Math.max(1000, (records.at(-1)?.time ?? 0) + 400);
  const snapshotsBySeq = new Map(bundle.snapshots.map(snapshot => [snapshot.seq, snapshot.view]));
  const markers = records.map((entry, ix) => ({ ...entry, ix, label: eventName(entry) })).filter(entry => entry.label);
  const targets = {
    slap: markers.filter(entry => hasImpact ? entry.type === 'impact-start' : ['slap', 'clap'].includes(entry.type)),
    conflict: markers.filter(entry => entry.type === 'review' && entry.item.data.issues?.some(issue => issue.status !== 'resolved')),
    version: markers.filter(entry => entry.type === 'version')
  };
  const begin = {
    view: {}, shown: null, context: {}, speaker: null, performing: null, line: '', tracks: {}, reviews: {}, shockUntil: -1, last: null,
    draft: '', eventFeedback: ''
  };

  function replayEvent(state, entry, index) {
    const { item, type, time, track } = entry;
    if (track === 'business') {
      if (item.view) state.view = item.view;
      if (snapshotsBySeq.has(item.seq)) state.view = snapshotsBySeq.get(item.seq);
      if (type === 'qr-checked') state.reviews[item.versionId] = item.data.review;
      if (!hasPresentation && type === 'message') {
        state.speaker = item.data.message.role;
        state.line = item.data.message.text;
      }
      if ((type === 'slap' || type === 'clap') && !hasImpact) state.shockUntil = time + (item.data.durationMs ?? 750);
      if (type === 'command-rejected') state.eventFeedback = item.data.error;
      if (type === 'version' || type === 'job-started') state.eventFeedback = '';
    } else {
      state.context = item.context ?? state.context;
      if (type === 'ui.state') state.shown = item.data;
      if (type === 'subtitle.presented' || type === 'subtitle-start') {
        state.line = item.data?.text ?? '';
        state.speaker = item.data?.role ?? null;
        if (type === 'subtitle-start') state.performing = item.data;
      }
      if (type === 'subtitle-end') {
        if (state.performing?.messageId === item.data?.messageId) state.performing = null;
      }
      if (type === 'impact-start') state.shockUntil = time + (item.data?.durationMs ?? 750);
      if (type === 'impact-end') state.shockUntil = time;
      const lane = item.data?.kind === 'effect' ? 'effect' : 'voice';
      if (type === 'audio-start') state.tracks[lane] = { ...item.data, time, key: index };
      if (type === 'audio-stop' || type === 'audio-end') {
        const clip = state.tracks[lane];
        if (clip && clip.messageId === item.data.messageId && clip.segmentId === item.data.segmentId) delete state.tracks[lane];
      }
      if (type === 'ui.draft') state.draft = item.data?.text ?? item.data?.value ?? '';
    }
    if (eventName(entry)) state.last = { time, label: eventName(entry) };
  }

  const checkpoints = [{ index: -1, state: structuredClone(begin) }];
  const working = structuredClone(begin);
  records.forEach((entry, index) => {
    replayEvent(working, entry, index);
    if ((index + 1) % 100 === 0 || entry.type === 'version') checkpoints.push({ index, state: structuredClone(working) });
  });

  const shell = node('div', 'replay-shell');
  shell.classList.toggle('replay-manga', manga);
  if (castAtlas || employeeAtlas) {
    // Direct rules keep large offline data URLs out of CSS variable expansion.
    const atlasStyle = node('style');
    atlasStyle.textContent = [
      castAtlas && `.replay-cast.has-manga-atlas .replay-sprite {background-image:url(${JSON.stringify(castAtlas)})}`,
      employeeAtlas && `.replay-mascot.has-manga-atlas {background-image:url(${JSON.stringify(employeeAtlas)})}`,
    ].filter(Boolean).join('\n');
    shell.append(atlasStyle);
  }
  const grid = node('div', 'replay-grid');
  const art = node('section', 'replay-art');
  const artTitle = node('h3', 'replay-art-title', bundle.theme.name);
  const posters = node('div', 'replay-posters');
  const poster = node('img', 'replay-poster');
  poster.alt = tr('该时刻的海报', 'Poster at this point in the replay');
  const before = node('img', 'replay-poster');
  before.alt = tr('对比海报', 'Poster for comparison');
  before.hidden = true;
  const posterMissing = node('p', 'replay-poster-missing', tr('此刻的海报资源缺失', 'The poster for this moment is missing.'));
  posterMissing.hidden = true;
  const board = node('section', 'replay-board');
  const artInfo = node('div', 'replay-art-info');
  const issueInfo = node('span', null, '');
  const versionInfo = node('strong', null, '');
  artInfo.append(versionInfo, issueInfo);
  posters.append(before, poster, posterMissing);
  art.append(artTitle, posters, artInfo);

  const cast = node('div', 'replay-cast');
  if (castAtlas) cast.classList.add('has-manga-atlas');
  const castMembers = {};
  for (const role of ['zhou', 'lin', 'tang']) {
    const person = node('div', 'replay-person');
    person.dataset.role = role;
    const sprite = node('span', 'replay-sprite');
    if (!castAtlas && bundle.castImages?.[role]) sprite.style.backgroundImage = `url(${JSON.stringify(bundle.castImages[role])})`;
    const info = node('div', 'replay-person-info');
    const score = node('strong');
    info.append(node('span', null, roleName(role)), score);
    person.append(sprite, info);
    cast.append(person);
    castMembers[role] = { person, score };
  }
  const employee = node('div', 'replay-employee');
  const mascot = node('span', 'replay-mascot');
  if (employeeAtlas) {
    mascot.classList.add('has-manga-atlas');
    mascot.setAttribute('aria-hidden', 'true');
    mascot.dataset.impactLabel = tr('啪！', 'Wham!');
  } else {
    mascot.innerHTML = '<svg viewBox="0 0 72 56" aria-hidden="true"><path d="M15 25V22a21 21 0 0 1 42 0v3" fill="none" stroke="#282929" stroke-width="5"/><rect x="14" y="14" width="44" height="39" rx="15" fill="#ff865c"/><rect x="8" y="22" width="9" height="16" rx="4" fill="#282929"/><rect x="55" y="22" width="9" height="16" rx="4" fill="#282929"/><rect x="22" y="23" width="28" height="19" rx="7" fill="#ffbd94"/><path class="replay-mascot-calm" d="M29 28v5m14-5v5m-10 4q3 3 6 0" fill="none" stroke="#282929" stroke-linecap="round" stroke-width="2.5"/><g class="replay-mascot-qaq"><path d="M25 32q4-8 8 0m6 0q4-8 8 0m-13 6q2-3 4 0" fill="none" stroke="#282929" stroke-linecap="round" stroke-width="2"/><path d="M25 35v7m22-7v7" stroke="#3778bb" stroke-width="3" stroke-linecap="round"/></g></svg>';
  }
  const employeeInfo = node('div', 'replay-employee-info');
  const jobText = node('strong');
  const progress = node('progress', 'replay-progress');
  progress.max = 100;
  progress.setAttribute('aria-label', tr('工单进度', 'Assignment progress'));
  employeeInfo.append(jobText, progress);
  employee.append(mascot, employeeInfo);
  const subtitle = node('div', 'replay-subtitle');
  const speaker = node('b');
  const words = node('p');
  subtitle.append(speaker, words);
  const receiver = node('div', 'replay-receiver');
  const context = node('p', 'replay-context');
  const draft = node('p', 'replay-draft');
  const feedback = node('p', 'replay-feedback');
  receiver.append(context, draft, feedback);
  board.append(cast, employee, subtitle, receiver);
  grid.append(art, board);

  const timeline = node('div', 'replay-timeline');
  const time = node('output', 'replay-time');
  const slider = node('input', 'replay-seek');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(Math.ceil(total));
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', tr('回放时间', 'Replay time'));
  timeline.append(slider, time);
  const controls = node('div', 'replay-controls');
  const playLabel = tr('播放', 'Play');
  const pauseLabel = tr('暂停', 'Pause');
  const play = node('button', 'replay-play', playLabel);
  const step = node('button', null, tr('单步', 'Step'));
  const speed = node('select');
  speed.setAttribute('aria-label', tr('播放速度', 'Playback speed'));
  for (const value of [0.5, 1, 1.5, 2, 3]) {
    const option = node('option', null, `${value}×`);
    option.value = String(value);
    speed.append(option);
  }
  speed.value = '1';
  controls.append(play, step, speed);
  for (const [kind, label] of [
    ['slap', tr('跳到拍桌', 'Jump to desk slap')],
    ['conflict', tr('跳到分歧', 'Jump to disagreement')],
    ['version', tr('跳到版本', 'Jump to version')]
  ]) {
    const next = node('button', null, label);
    next.disabled = !targets[kind].length;
    next.onclick = () => {
      const marker = targets[kind].find(event => event.ix > currentIndex) ?? targets[kind][0];
      seek(marker.time, marker.ix);
    };
    controls.append(next);
  }
  const moment = node('p', 'replay-moment');
  const activity = node('details', 'replay-activity');
  activity.append(node('summary', null, `${tr('操作记录', 'Activity log')} · ${markers.length}`));
  const list = node('ol', 'replay-event-list');
  const listItems = [];
  for (const marker of markers) {
    const row = node('li');
    const control = node('button', null, `${formatTime(marker.time)}　${marker.label}`);
    control.onclick = () => seek(marker.time, marker.ix);
    row.append(control);
    list.append(row);
    listItems.push({ time: marker.ix, control });
  }
  activity.append(list);
  const recordings = bundle.media.filter(entry => entry.meta?.kind === 'recording');
  const audioPanel = node('details', 'replay-activity');
  if (recordings.length) {
    audioPanel.append(node('summary', null, `${tr('经理录音', 'Manager recordings')} · ${recordings.length}`));
    for (const entry of recordings) {
      const line = node('div', 'replay-recording');
      line.append(node('span', null, formatTime(Math.max(0, entry.at - bundle.startedAt))));
      const source = bundle.assets[entry.hash]?.url;
      if (source) {
        const recording = node('audio');
        recording.controls = true;
        recording.preload = 'none';
        recording.src = source;
        recording.onplay = () => setPlaying(false);
        line.append(recording);
      } else line.append(node('span', null, tr('录音缺失', 'Recording missing')));
      audioPanel.append(line);
    }
  }
  shell.append(grid, timeline, controls, moment, activity);
  if (recordings.length) shell.append(audioPanel);
  if (bundle.missing.length) {
    const missing = node('details', 'replay-activity');
    missing.append(node('summary', null, `${tr('缺少资源', 'Missing files')} · ${bundle.missing.length}`));
    const rows = node('ul');
    for (const hash of bundle.missing) {
      const version = bundle.versions.find(version => [version.hash, version.pngHash, version.uploadHash].includes(hash));
      const clip = bundle.presentation.find(entry => entry.data?.hash === hash);
      const message = clip?.data?.messageId;
      const label = from(artworkLabels, hash) ?? (version ? tr(`${version.id} 的海报资源`, `${version.id} poster file`)
        : clip ? tr(`${message ?? '发言'} 的配音`, message ? `Voice track for ${message}` : 'Voice track')
          : tr(`资源 ${hash.slice(0, 12)}`, `File ${hash.slice(0, 12)}`));
      rows.append(node('li', null, label));
    }
    missing.append(rows);
    shell.append(missing);
  }
  root.replaceChildren(shell);

  let position = 0;
  let currentIndex = -2;
  let viewState = structuredClone(begin);
  let playing = false;
  let ticking = 0;
  let started = 0;
  let origin = 0;
  const audible = new Map();
  let previousMarker = null;

  function syncAudio(state, force = false) {
    for (const lane of ['voice', 'effect']) {
      const clip = state.tracks[lane];
      const url = clip && (bundle.assets[clip.hash]?.url || (!clip.hash && clip.assetUrl?.startsWith('data:') ? clip.assetUrl : null));
      const running = audible.get(lane);
      if (!playing || !url) {
        running?.element.pause();
        audible.delete(lane);
        continue;
      }
      if (running?.key === clip.key && !force) continue;
      running?.element.pause();
      const element = new Audio(url);
      const originalRate = Number(clip.playbackRate) || 1;
      if (originalRate !== 1) element.preservesPitch = false;
      element.playbackRate = Number(speed.value) * originalRate;
      audible.set(lane, { key: clip.key, element });
      const jump = () => {
        if (audible.get(lane)?.element !== element || !playing) return;
        const offset = ((Number(clip.offsetMs) || 0) + Math.max(0, position - clip.time) * originalRate) / 1000;
        element.currentTime = Number.isFinite(element.duration) ? Math.min(offset, element.duration) : offset;
        element.play().catch(() => {});
      };
      if (element.readyState >= 1) jump();
      else element.addEventListener('loadedmetadata', jump, { once: true });
    }
  }

  function image(element, version) {
    const url = version && bundle.assets[version.pngHash]?.url;
    element.hidden = !url;
    if (url && element.getAttribute('src') !== url) element.src = url;
    return !!url;
  }

  function updateEmployeePose(state) {
    const shocked = position < state.shockUntil;
    employee.classList.toggle('is-shocked', shocked);
    if (!employeeAtlas) return;
    const status = (state.shown ?? state.view).job?.status;
    const pose = shocked ? 'qaq' : status === 'paused' ? 'slack' : ['working', 'queued', 'accepted', 'resumed', 'running'].includes(status) ? 'work' : 'idle';
    if (mascot.dataset.pose !== pose) mascot.dataset.pose = pose;
  }

  function draw(state, index) {
    const { context: stateUI } = state;
    const view = state.shown ?? state.view;
    const version = byVersion.get(view.selectedVersionId || stateUI.versionId) ?? bundle.versions[0];
    const compared = stateUI.comparing && byVersion.get(stateUI.comparisonVersionId ?? version?.parentId);
    image(before, compared);
    posterMissing.hidden = image(poster, version);
    posters.classList.toggle('is-compared', Boolean(compared));
    poster.style.transform = !compared && Number.isFinite(stateUI.zoom) ? `scale(${stateUI.zoom})` : '';
    versionInfo.textContent = version ? `${version.id} · ${version.label}` : tr('海报未生成', 'Poster not yet generated');
    const issueCount = view.issueCount;
    issueInfo.textContent = issueCount ? tr(`${issueCount} 项分歧`, `${issueCount} ${issueCount === 1 ? 'disagreement' : 'disagreements'}`) : '';
    for (const [role, member] of Object.entries(castMembers)) {
      const review = (state.reviews[version?.id] ?? version?.review)?.[role];
      member.score.textContent = review?.pendingWeight ? `${review.referenceScore ?? review.lowerBound ?? 0} · ${tr('待验', 'Pending')}` : String(review?.score ?? '');
      member.person.classList.toggle('is-speaking', state.performing?.role === role);
      member.person.classList.toggle('is-selected', (stateUI.role || view.selectedRole) === role);
    }
    employee.classList.toggle('is-speaking', state.performing?.role === 'yi');
    jobText.textContent = !view.job
      ? tr('小乙 · 待命', 'Xiao Yi · On standby')
      : `${view.job.id} · ${from(statusNames, view.job.status) ?? view.job.status} · ${view.job.progress}%`;
    progress.value = view.job?.progress ?? 0;
    speaker.textContent = roleName(state.speaker) ?? '';
    words.textContent = state.line;
    const summary = [];
    const recipient = roleName(stateUI.role || view.selectedRole);
    if (recipient) summary.push(`${tr('收件人', 'Recipient')} ${recipient}`);
    if (stateUI.zoom && stateUI.zoom !== 1) summary.push(`${tr('缩放', 'Zoom')} ${Math.round(Number(stateUI.zoom) * 100)}%`);
    if (stateUI.muted) summary.push(tr('静音', 'Muted'));
    if (view.finalizedVersionId) summary.push(`${tr('已定稿', 'Finalized')} ${view.finalizedVersionId}`);
    if (typeof stateUI.dialog === 'string' && stateUI.dialog) summary.push(from(panelNames, stateUI.dialog) ?? stateUI.dialog);
    context.textContent = summary.join(' · ');
    const drafts = Object.values(stateUI.drafts ?? {}).filter(value => typeof value === 'string' && value.trim());
    draft.textContent = drafts.length || state.draft ? `${tr('草稿', 'Draft')} · ${drafts.join(' / ') || state.draft}` : '';
    feedback.textContent = state.eventFeedback;
    moment.textContent = state.last ? `${formatTime(state.last.time)}　${state.last.label}` : '';
    const match = listItems[upper(listItems, index) - 1];
    if (match !== previousMarker) {
      previousMarker?.control.removeAttribute('aria-current');
      match?.control.setAttribute('aria-current', 'step');
      previousMarker = match;
    }
  }

  function setPosition(pos, targetIndex, forceAudio = false) {
    position = Math.max(0, Math.min(pos, total));
    const index = targetIndex ?? upper(records, position) - 1;
    if (index !== currentIndex) {
      if (index < currentIndex || (currentIndex < -1 || index - currentIndex > 100)) {
        const checkpoint = checkpoints.findLast(snapshot => snapshot.index <= index) ?? checkpoints[0];
        viewState = structuredClone(checkpoint.state);
        currentIndex = checkpoint.index;
      }
      for (let i = currentIndex + 1; i <= index; i++) replayEvent(viewState, records[i], i);
      currentIndex = index;
      draw(viewState, currentIndex);
    }
    updateEmployeePose(viewState);
    slider.value = String(Math.round(position));
    time.value = `${formatTime(position)} / ${formatTime(total)}`;
    syncAudio(viewState, forceAudio);
  }

  function tick(now) {
    const next = origin + (now - started) * Number(speed.value);
    setPosition(next);
    if (next < total && playing) ticking = requestAnimationFrame(tick);
    else setPlaying(false);
  }

  function seek(pos, index) {
    setPlaying(false);
    setPosition(pos, index, true);
  }

  function setPlaying(value) {
    playing = value;
    cancelAnimationFrame(ticking);
    play.textContent = playing ? pauseLabel : playLabel;
    if (!playing) return syncAudio(viewState);
    if (position >= total) setPosition(0);
    started = performance.now();
    origin = position;
    syncAudio(viewState, true);
    ticking = requestAnimationFrame(tick);
  }

  play.onclick = () => setPlaying(!playing);
  step.onclick = () => {
    const next = currentIndex + 1;
    if (records[next]) seek(records[next].time, next);
  };
  slider.oninput = () => seek(Number(slider.value));
  speed.onchange = () => { if (playing) setPlaying(true); };
  setPosition(0);
  return { destroy() { setPlaying(false); root.replaceChildren(); } };
}
