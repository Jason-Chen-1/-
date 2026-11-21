import { t } from '../i18n.js';

export const roles = {
  zhou: {
    name: t('周总', 'Director Zhou'), job: t('老板', 'Director'),
    questions: [t('高级具体指哪里？', 'What should look more polished?'), t('缩成手机大小先看见什么？', 'What should stand out first on a phone?'), t('你能接受黄贴放哪？', 'Where can the yellow sticker go?')]
  },
  lin: {
    name: t('林尺', 'Lin Chi'), job: t('品牌负责人', 'Brand lead'),
    questions: [t('联名规范具体是哪条？', 'Which co-branding rule matters here?'), t('用哪份馆标？放哪儿？', 'Which museum logo should we use, and where?'), t('馆标和署名能移到左下吗？', 'Can we move the logo and credits to the lower left?')]
  },
  tang: {
    name: t('阿唐', 'A-Tang'), job: t('活动负责人', 'Events lead'),
    questions: [t('几个卖点先突出哪个？', 'Which selling point comes first?'), t('免费和须预约放在哪儿？', 'Where should admission and booking details go?'), t('预约码旁边可以吗？', 'Could they sit next to the booking QR code?')]
  },
  yi: { name: t('小乙', 'Xiao Yi'), job: t('执行设计师', 'Production designer') },
  manager: { name: t('我', 'Me') }
};

export const find = (id) => document.getElementById(id);
export const versionUrl = (session, versionId) => `/api/sessions/${encodeURIComponent(session.id)}/versions/${encodeURIComponent(versionId)}/poster.svg`;

export function node(tag, { className = '', text = '', attrs = {} } = {}, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

export function button(text, click, className = 'button small', key = '') {
  const element = node('button', { className, text, attrs: { type: 'button' } });
  if (key) element.dataset.record = key;
  element.addEventListener('click', click);
  return element;
}

export function scoreText(summary) {
  if (!summary) return '—';
  if (summary.score != null) return String(summary.score);
  if (summary.previousScore != null) return String(summary.previousScore);
  return `≥${summary.lowerBound ?? 0}`;
}

export const signed = (value) => value == null ? '' : value > 0 ? `+${value}` : String(value).replace('-', '−');

const labelFacts = {
  title: t('主题', 'Theme'), museum: t('馆名', 'Museum'), venue: t('地点', 'Venue'),
  organizer: t('主办方', 'Organizer'), location: t('地点', 'Location'), date: t('时间', 'Date'),
  dates: t('展期', 'Exhibition dates'), period: t('展期', 'Exhibition dates'), hours: t('时段', 'Hours'),
  time: t('时段', 'Time'), admission: t('参与条件', 'Admission'), entry: t('入场', 'Entry'),
  entrance: t('入场', 'Entrance'), gate: t('入场', 'Entry'), cost: t('费用', 'Cost'), fee: t('费用', 'Fee'),
  reservation: t('预约', 'Booking'), registration: t('预约', 'Registration'), partner: t('合作方', 'Partner'),
  address: t('地址', 'Address'), subtitle: t('副标题', 'Subtitle'), credit: t('署名', 'Credit'),
  credits: t('署名', 'Credits'), reservationPath: t('预约页', 'Booking page')
};

function factText(value) {
  if (Array.isArray(value)) return value.map(factText).join(' · ');
  if (value && typeof value === 'object') return Object.values(value).map(factText).join(' · ');
  if (typeof value === 'boolean') return value ? t('是', 'Yes') : t('否', 'No');
  return String(value ?? '');
}

function projectFacts(facts) {
  const list = node('dl', { className: 'project-facts' });
  if (Array.isArray(facts)) {
    for (const [index, fact] of facts.entries()) {
      list.append(node('dt', { text: fact.label ?? fact.name ?? t(`信息 ${index + 1}`, `Detail ${index + 1}`) }),
        node('dd', { text: factText(fact.value ?? fact.text ?? fact) }));
    }
  } else {
    for (const [key, value] of Object.entries(facts ?? {})) {
      const label = labelFacts[key] ?? (/[\p{Script=Han}]/u.test(key) ? key : null);
      if (label) list.append(node('dt', { text: label }), node('dd', { text: factText(value) }));
    }
  }
  return list;
}

function traceRole(id) {
  return Object.hasOwn(roles, id) ? roles[id].name : id || t('系统', 'System');
}

function traceIdentity(entry) {
  if (typeof entry.callId === 'string' && entry.callId) return entry.callId;
  if (typeof entry.input?.callId === 'string' && entry.input.callId) return entry.input.callId;
  return entry.input && Object.hasOwn(entry.input, 'arguments') && typeof entry.input.id === 'string' ? entry.input.id : '';
}

function traceState(entry) {
  const stated = String(entry.status ?? '').toLowerCase();
  const http = entry.output?.httpStatus ?? entry.httpStatus;
  const reason = entry.tool === 'chat.completions' ? entry.output?.finish_reason ?? entry.finishReason ?? entry.finish_reason : undefined;
  const truncated = reason === 'length' || stated === 'truncated';
  const notExecuted = entry.output?.executed === false || ['not_executed', 'not-executed', 'skipped'].includes(stated);
  const failed = !truncated && !notExecuted && (['error', 'failed', 'failure', 'rejected', 'invalid'].includes(stated) || (Number.isInteger(http) && http >= 400));
  const succeeded = !truncated && !notExecuted && !failed && ['ok', 'success', 'succeeded', 'completed'].includes(stated);
  const recovery = ['repair', 'repaired', 'retry', 'retrying', 'recovered'].includes(stated);
  const labels = {
    ok: t('成功', 'Succeeded'), success: t('成功', 'Succeeded'), succeeded: t('成功', 'Succeeded'),
    start: t('开始', 'Started'), started: t('开始', 'Started'), running: t('进行中', 'Running'),
    end: t('结束', 'Ended'), completed: t('已完成', 'Completed'),
    failed: t('失败', 'Failed'), error: t('失败', 'Failed'),
    repair: t('修复', 'Repair'), repaired: t('已修复', 'Repaired'), recovered: t('已恢复', 'Recovered'),
    retry: t('重试', 'Retry'), retrying: t('重试中', 'Retrying')
  };
  const label = truncated ? t('响应被截断', 'Response truncated') : notExecuted ? t('未执行', 'Not executed')
    : failed ? t('失败', 'Failed') : labels[stated] ?? entry.status ?? '';
  return { failed, recovery, truncated, notExecuted, succeeded, http, reason, label };
}

function tracePayload(heading, value) {
  const clipped = value?.truncated === true && typeof value.json === 'string';
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (clipped) text = value.json;
  else if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    try { text = JSON.stringify(JSON.parse(value), null, 2); } catch { /* Keep the exact malformed argument. */ }
  }
  return node('section', { className: 'tool-trace-payload' }, node('h3', { text: heading }),
    ...(clipped ? [hint(t('此处只保存了开头。', 'Only the beginning of this payload was retained.'))] : []),
    node('pre', { text, attrs: { tabindex: '0', 'aria-label': heading } }));
}

function hint(text) {
  return node('p', { className: 'sheet-note', text });
}

function traceRunGroups(values) {
  const groups = new Map();
  for (const [order, entry] of (Array.isArray(values) ? values : []).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const runId = entry.runId || '';
    const key = runId ? `run:${runId}` : `record:${entry.id ?? order}`;
    if (!groups.has(key)) groups.set(key, { key, runId, entries: [] });
    const run = groups.get(key);
    run.entries.push({ entry, key: entry.id || `position:${order}` });
    run.last = order;
  }
  return [...groups.values()].sort((first, second) => second.last - first.last);
}

function keepTraceOrder(container, elements) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  let current = container.firstElementChild;
  for (const element of elements) {
    if (current === element) current = current.nextElementSibling;
    else if (element.parentNode === container && typeof container.moveBefore === 'function') container.moveBefore(element, current);
    else container.insertBefore(element, current);
  }
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }
  if (focused && container.contains(focused) && focused !== document.activeElement) focused.focus({ preventScroll: true });
}

function renderTraceStep(entry, details, afterTruncation) {
  const callId = traceIdentity(entry);
  const model = entry.tool === 'chat.completions';
  const state = traceState(entry);
  const followUp = Boolean(afterTruncation && callId && state.succeeded);
  const label = followUp ? t('截断后执行成功', 'Succeeded after truncation') : state.label;
  const operation = entry.tool || t('记录的操作', 'Recorded operation');
  details.className = 'tool-trace-step';
  details.dataset.callId = callId;
  details.dataset.kind = model ? 'model' : callId ? 'tool' : 'operation';
  details.dataset.state = state.truncated ? 'truncated' : state.notExecuted ? 'not-executed'
    : state.failed ? 'error' : state.recovery || followUp ? 'repair' : '';
  const descriptor = model ? t('模型请求', 'Model request') : callId ? t('工具调用', 'Tool call') : t('应用操作', 'Application operation');
  const metadata = [descriptor, traceRole(entry.role), entry.versionId, model ? entry.output?.model ?? entry.input?.model : '',
    typeof state.reason === 'string' && state.reason ? `finish_reason = ${state.reason}` : '',
    Number.isInteger(state.http) ? `HTTP ${state.http}` : '', Number.isFinite(entry.durationMs) ? `${entry.durationMs} ms` : ''].filter(Boolean);
  const summary = node('summary', {}, node('span', { className: 'tool-trace-summary' },
    node('strong', { text: operation }),
    ...(callId ? [node('code', { text: callId, attrs: { 'aria-label': t(`调用 ID ${callId}`, `Call ID ${callId}`) } })] : []),
    ...(label ? [node('span', { className: 'tool-trace-status', text: label })] : []),
    node('small', { className: 'sheet-note', text: metadata.join(' · ') })));
  const input = callId && entry.input && Object.hasOwn(entry.input, 'arguments') ? entry.input.arguments : entry.input;
  const inputHeading = model ? t('请求', 'Request') : callId ? t('参数', 'Arguments') : t('输入', 'Input');
  const outputHeading = model ? t('响应', 'Response') : state.notExecuted ? t('跳过原因', 'Reason skipped')
    : callId ? t('执行结果', 'Result') : t('输出', 'Output');
  const payloads = node('div', { className: 'tool-trace-payloads' },
    ...(input === undefined ? [] : [tracePayload(inputHeading, input)]),
    ...(entry.output === undefined ? [] : [tracePayload(outputHeading, entry.output)]));
  const rawLabel = t('原始记录', 'Raw record');
  const raw = node('details', { className: 'tool-trace-raw' }, node('summary', { text: rawLabel }),
    node('pre', { text: JSON.stringify(entry, null, 2), attrs: { tabindex: '0', 'aria-label': rawLabel } }));
  details.replaceChildren(summary, payloads, raw);
}

export function createSheets(actions) {
  const dialog = find('modal');
  const title = find('modalTitle');
  const body = find('modalBody');
  let pending = new Set();
  let currentSheet = '';
  let updateContent;
  let disposeContent;

  function close() {
    disposeContent?.();
    if (dialog.open) dialog.close();
  }

  function show(kind, heading, ...content) {
    disposeContent?.();
    disposeContent = undefined;
    updateContent = undefined;
    if (dialog.open && currentSheet !== kind) actions.record('ui.dialog', { name: currentSheet, open: false });
    currentSheet = kind;
    dialog.dataset.sheet = kind;
    title.textContent = heading;
    body.replaceChildren(...content);
    body.scrollTop = 0;
    dialog.scrollTop = 0;
    if (!dialog.open) dialog.showModal();
    actions.record('ui.dialog', { name: kind, open: true });
  }

  find('closeModal').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    disposeContent?.();
    disposeContent = undefined;
    updateContent = undefined;
    actions.record('ui.dialog', { name: currentSheet, open: false });
    currentSheet = '';
    delete dialog.dataset.sheet;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });

  function controls(...children) {
    return node('div', { className: 'modal-actions' }, ...children);
  }

  function traces() {
    const filters = node('div', { className: 'chip-row', attrs: { role: 'group', 'aria-label': t('按角色筛选', 'Filter by role') } });
    const list = node('div', { className: 'tool-trace-list' });
    const selector = new Map();
    const rows = new Map();
    let selected = '';
    let rendered;

    function update() {
      const values = actions.getSession()?.toolTraces;
      const key = JSON.stringify([selected, values]);
      if (key === rendered) return;
      rendered = key;
      const runs = traceRunGroups(values);
      const retained = new Set(runs.map(run => run.key));
      for (const id of rows.keys()) if (!retained.has(id)) rows.delete(id);
      const visible = runs.filter(run => !selected || run.entries.some(({ entry }) => entry.role === selected));
      const elements = visible.map((run, index) => {
        let row = rows.get(run.key);
        const isNew = !row;
        if (!row) {
          const summary = node('summary');
          const steps = node('ol', { className: 'tool-trace-steps' });
          const details = node('details', { className: 'tool-trace-run' }, summary, steps);
          details.dataset.run = run.runId;
          details.open = index === 0;
          row = { details, summary, steps, entries: new Map() };
          rows.set(run.key, row);
        }
        const names = [...new Set(run.entries.map(({ entry }) => traceRole(entry.role)))];
        const count = run.entries.length;
        const states = run.entries.map(({ entry }) => traceState(entry));
        const failures = states.filter(state => state.failed).length;
        const truncations = states.filter(state => state.truncated).length;
        const summaryKey = JSON.stringify([names, count, failures, truncations]);
        if (row.summaryKey !== summaryKey) {
          row.summaryKey = summaryKey;
          row.summary.replaceChildren(node('span', { className: 'tool-trace-summary' },
            node('strong', { text: names.join(' · ') }),
            ...(run.runId ? [node('code', { text: run.runId, attrs: { 'aria-label': t(`执行批次 ${run.runId}`, `Run ID ${run.runId}`) } })] : []),
            node('small', { className: 'sheet-note', text: t(`${count} 条记录`, count === 1 ? '1 record' : `${count} records`) }),
            ...(truncations ? [node('span', { className: 'tool-trace-status is-truncated', text: t(`${truncations} 条截断`, `${truncations} truncated`) })] : []),
            ...(failures ? [node('span', { className: 'tool-trace-status is-error', text: t(`${failures} 条失败`, `${failures} failed`) })] : [])));
        }
        const firstTruncation = states.findIndex(state => state.truncated);
        const initial = isNew && (run.entries[firstTruncation] ?? run.entries[states.findIndex(state => state.failed)] ??
          run.entries.find(({ entry }) => traceIdentity(entry)) ?? run.entries[0]);
        const recordIds = new Set(run.entries.map(record => record.key));
        for (const id of row.entries.keys()) if (!recordIds.has(id)) row.entries.delete(id);
        keepTraceOrder(row.steps, run.entries.map((record, position) => {
          let view = row.entries.get(record.key);
          if (!view) {
            const details = node('details');
            details.open = initial === record;
            view = { details, item: node('li', {}, details) };
            row.entries.set(record.key, view);
          }
          const afterTruncation = firstTruncation >= 0 && position > firstTruncation;
          const signature = JSON.stringify([record.entry, afterTruncation]);
          if (view.signature !== signature) {
            view.signature = signature;
            renderTraceStep(record.entry, view.details, afterTruncation);
          }
          return view.item;
        }));
        return row.details;
      });
      keepTraceOrder(list, elements.length ? elements : [hint(t('暂无工具调用。', 'No tool calls yet.'))]);
    }

    for (const [role, name] of [['', t('全部', 'All')], ...['zhou', 'lin', 'tang', 'yi'].map((id) => [id, roles[id].name])]) {
      const filter = button(name, () => {
        if (role === selected) return;
        selected = role;
        for (const [id, control] of selector) control.setAttribute('aria-pressed', String(id === role));
        actions.record('ui.toggle', { name: 'toolTraceRole', value: role || 'all' });
        update();
      }, 'button small');
      filter.setAttribute('aria-pressed', String(role === selected));
      selector.set(role, filter);
      filters.append(filter);
    }
    show('tool-traces', t('原始工具调用链', 'Raw tool call chains'), filters, list);
    updateContent = update;
    update();
  }

  function materials() {
    const lifetime = new AbortController();
    const url = node('input', { className: 'material-url', attrs: { type: 'url', name: 'imageUrl', placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('图片链接', 'Image URL') } });
    const submit = node('button', { className: 'button primary small', text: t('导入链接', 'Import URL'), attrs: { type: 'submit' } });
    const form = node('form', { className: 'material-import', attrs: { novalidate: '' } }, url, submit);
    const file = node('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml', hidden: '' } });
    const pick = button(t('选择本机图片', 'Choose an image file'), () => file.click(), 'button small', 'materials:choose-file');
    const status = node('p', { className: 'sheet-note material-status', attrs: { role: 'status' } });
    const list = node('div', { className: 'material-list' });
    let busy = false;
    let rendered;

    function update() {
      const values = actions.getSession()?.materials;
      const stored = Array.isArray(values) ? [...values].reverse() : [];
      const key = JSON.stringify(stored);
      if (key === rendered) return;
      rendered = key;
      const rows = stored.map((item) => node('div', { className: 'material-row' },
        node('div', {}, node('strong', { text: item.name }), node('small', { className: 'sheet-note', text: item.id })),
        button(t('派给小乙', 'Assign to Xiao Yi'), () => {
          close();
          actions.prepareMaterial(item.id);
        }, 'button small', 'materials:offer')));
      list.replaceChildren(...(rows.length ? rows : [hint(t('素材库为空。', 'The material library is empty.'))]));
    }

    async function add(source) {
      if (busy) return;
      busy = true;
      submit.disabled = pick.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.classList.remove('error');
      status.textContent = t('正在导入…', 'Importing…');
      try {
        const result = await actions.importMaterial(source, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (typeof source === 'string' && url.value.trim() === source) url.value = '';
        status.textContent = t(`已入库 · ${result.name}`, `Added · ${result.name}`);
      } catch (error) {
        if (lifetime.signal.aborted) return;
        status.classList.add('error');
        status.textContent = error.message;
      } finally {
        busy = false;
        submit.disabled = pick.disabled = false;
        form.removeAttribute('aria-busy');
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void add(url.value.trim());
    });
    file.addEventListener('change', () => {
      const selected = file.files?.[0];
      file.value = '';
      if (selected) void add(selected);
    });
    show('materials', t('素材库', 'Materials'), form, node('div', {}, pick, file), status, list);
    disposeContent = () => lifetime.abort();
    updateContent = update;
    update();
  }

  function evidenceButtons(ids, versionId) {
    const version = actions.getSession()?.versions.find((item) => item.id === versionId) ?? actions.getVersion();
    const labels = new Map((version?.elements ?? []).map((item) => [item.id, item.label]));
    return node('div', { className: 'chip-row' }, ...(ids ?? []).filter((id) => labels.has(id)).map((id) =>
      button(t(`定位${labels.get(id)}`, `Locate ${labels.get(id)}`), () => {
        close();
        actions.locate([id], version?.id);
      }, 'text-button', `evidence:${id}`)
    ));
  }

  function score(roleId, versionId = actions.getVersion()?.id) {
    const version = actions.getSession()?.versions.find((item) => item.id === versionId);
    const summary = version?.review?.[roleId];
    if (!version || !summary) return;
    const heading = node('div', { className: 'sheet-heading' },
      node('strong', { className: 'sheet-score', text: `${scoreText(summary)} / 100` }),
      node('span', { className: `delta ${summary.delta < 0 ? 'down' : 'up'}`, text: signed(summary.delta) })
    );
    const notes = [];
    if (summary.pendingWeight > 0) {
      notes.push(hint(summary.referenceVersionId
        ? t(`待验证 ${summary.pendingWeight} 分，暂显示 ${summary.referenceVersionId} 的分数。`,
          `${summary.pendingWeight} points pending verification. Showing the score for ${summary.referenceVersionId}.`)
        : t(`待验证 ${summary.pendingWeight} 分，当前已证实至少 ${summary.lowerBound ?? 0} 分。`,
          `${summary.pendingWeight} points pending verification. At least ${summary.lowerBound ?? 0} points confirmed.`)));
    } else if (summary.delta != null && version.parentId) {
      const reference = summary.referenceVersionId ?? version.parentId;
      notes.push(hint(t(`与 ${reference} 比较`, `Compared with ${reference}`)));
    }
    const rows = (summary.items ?? []).map((item) => {
      const pendingItem = item.level == null || item.level === 'pending';
      const inapplicable = item.state === 'notApplicable' || item.level === 'na' || item.applicable === false;
      const itemScore = inapplicable ? t('不适用', 'N/A') : pendingItem ? t('待验证', 'Pending verification') : `${item.earned ?? 0} / ${item.weight}`;
      const canVerify = roleId === 'tang' && item.id === 'reservation-qr' && pendingItem && !inapplicable;
      return node('article', { className: 'sheet-row' },
        node('div', { className: 'sheet-heading' },
          node('h3', { text: item.label ?? item.id }),
          node('span', { className: 'sheet-score', text: itemScore })),
        node('p', { text: item.reason ?? '' }),
        evidenceButtons(item.elementIds, version.id),
        ...(canVerify ? [controls(button(t('复核预约码', 'Recheck booking QR code'), async (event) => {
          const check = event.currentTarget;
          check.disabled = true;
          const okay = await actions.command('verifyReservation', { versionId: version.id });
          if (okay && dialog.open) score(roleId, version.id);
          else check.disabled = false;
        }, 'button small', `score:verify:${version.id}`))] : []));
    });
    const name = roles[roleId].name;
    show('score', t(`${name}评分 · ${version.id}`, `${name}'s score · ${version.id}`), heading, ...notes, ...rows);
  }

  function transcript() {
    const session = actions.getSession();
    const byId = new Map((session?.messages ?? []).map((message) => [message.id, message]));
    const messages = (session?.messages ?? []).filter((message) =>
      (message.role in roles && message.role !== 'yi' && message.role !== 'manager') ||
      (message.role === 'manager' && ['question', 'ask'].includes(message.kind) &&
        (message.target ?? message.targetRole) !== 'yi')
    );
    show('transcript', t('甲方对话', 'Client conversation'), ...messages.map((message) => {
      const source = byId.get(message.replyTo);
      const sourceName = source && (roles[source.role]?.name ?? source.role);
      return node('article', { className: 'sheet-row log-entry' },
        node('div', { className: 'sheet-heading' },
          node('h3', { text: roles[message.role]?.name ?? message.role }),
          node('span', { className: 'sheet-note', text: message.versionId ?? '' })),
        ...(source ? [hint(t(`回应${sourceName} · ${source.text}`, `Reply to ${sourceName} · ${source.text}`))] : []),
        node('p', { text: message.text }),
        node('div', { className: 'sheet-heading' },
          evidenceButtons(message.elementIds, message.versionId),
          ...(message.role !== 'manager'
            ? [button(t('转交小乙', 'Send to Xiao Yi'), () => forward([message]), 'button small', `forward:${message.id}`)] : [])));
    }));
  }

  function forward(sources) {
    if (!sources.length) return;
    const versionId = actions.getVersion()?.id;
    const ids = sources.map((item) => item.id ?? item.sourceMessageId).filter(Boolean);
    const messages = actions.getSession()?.messages ?? [];
    const originals = sources.map((item) => messages.find((message) => message.id === item.sourceMessageId) ?? item);
    const original = originals.map((item) => item.text).join('\n');
    const draft = node('textarea', {
      className: 'edit-forward-text',
      attrs: { id: 'forwardDraft', maxlength: '1600', rows: '3', 'aria-label': t('经理的工单', 'Manager’s assignment') }
    });
    draft.value = sources.map((item) => item.displayInstruction || item.text).join('\n');
    draft.addEventListener('input', () => actions.record('ui.draft', { target: 'forward', value: draft.value, sourceIds: ids }));
    const submit = async (text, source) => {
      if (!text.trim()) {
        draft.focus();
        return;
      }
      const okay = await actions.assign({ text, sourceIds: ids, baseVersionId: versionId, source });
      if (okay) {
        pending.clear();
        close();
      }
    };
    show('forward', sources.length === 1 ? t('转交甲方意见', 'Forward client feedback') : t('合并意见', 'Combine feedback'),
      ...originals.map((item) => node('blockquote', { className: 'quote-source', text: `${roles[item.role]?.name ?? t('原话', 'Original quote')} · ${item.text}` })),
      draft,
      controls(
        ...(sources.length === 1
          ? [button(t('原样转交', 'Send as written'), () => submit(original, 'quote'), 'button', 'forward:verbatim')] : []),
        button(sources.length === 1 ? t('编辑后派工', 'Send edited assignment') : t('合并派工', 'Send combined assignment'),
          () => submit(draft.value, sources.length === 1 ? 'edited' : 'merged'), 'button primary', 'forward:confirm')
      ));
  }

  function requirementSource(requirement, source) {
    const name = roles[requirement.role]?.name ?? t('甲方', 'Client');
    show('requirement-source', t(`${name}的原话`, `${name}’s original comment`),
      node('blockquote', { className: 'quote-source', text: source.text }),
      ...(source.elementIds?.length ? [evidenceButtons(source.elementIds, source.versionId)] : []),
      controls(button(t('转交小乙', 'Send to Xiao Yi'), () => forward([requirement]), 'button primary', `requirement:quote-forward:${requirement.id}`)));
  }

  function feedback(active = 'requirements') {
    const session = actions.getSession();
    if (!session) return;
    const version = actions.getVersion();
    const requirements = session.requirements ?? [];
    const issues = (version?.issues ?? session.issues ?? []).filter((issue) => !issue.versionId || issue.versionId === version?.id);
    const heading = t('需求与分歧', 'Requirements and disagreements');
    const detailHeading = version ? `${version.id} · ${heading}` : heading;
    const switcher = node('div', { className: 'section-switch', attrs: { role: 'tablist', 'aria-label': heading } });
    for (const [id, text] of [['requirements', t('需求', 'Requirements')], ['issues', t('分歧', 'Disagreements')]]) {
      const tab = button(text, () => feedback(id), 'tab', `feedback:${id}`);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === active));
      switcher.append(tab);
    }
    if (active === 'issues') {
      const rows = issues.map((issue) => {
        const opinions = issue.opinions ?? [];
        const involved = (issue.roles ?? opinions.map((opinion) => opinion.role)).map((id) => roles[id]?.name).filter(Boolean).join(t('、', ', '));
        const status = { resolved: t('已处理', 'Resolved'), pending: t('待验证', 'Pending verification') }[issue.status] ?? involved;
        return node('article', { className: 'sheet-row' },
          node('div', { className: 'sheet-heading' },
            node('h3', { text: issue.label ?? t('意见分歧', 'Disagreement') }),
            node('span', { className: 'sheet-note', text: status })),
          ...(issue.text ? [node('p', { text: issue.text })] : []),
          ...opinions.map((opinion) => node('p', {}, node('strong', { text: `${roles[opinion.role]?.name ?? ''} ` }),
            document.createTextNode(opinion.reason ?? ''))),
          evidenceButtons(issue.elementIds, version?.id));
      });
      show('feedback', detailHeading, switcher, ...(rows.length ? rows : [hint(t('这版没有已记录的分歧。', 'No disagreements were recorded for this version.'))]));
      return;
    }
    const combine = button(t('合并转交', 'Combine and forward'), () => forward(requirements.filter((item) => pending.has(item.id))), 'button primary', 'requirement:combine');
    combine.disabled = pending.size === 0;
    const requirementRows = requirements.map((item) => {
      const deferred = ['deferred', 'snoozed', 'parked'].includes(item.status);
      const clarified = t('已问清', 'Clarified');
      const ambiguous = t('待问清', 'Needs clarification');
      const assigned = t('已派工', 'Assigned');
      const done = t('已完成', 'Complete');
      const openStatus = { concession: t('已确认让步', 'Compromise confirmed'), criterion: clarified, goal: t('已明确目标', 'Goal defined') }[item.stage] ?? ambiguous;
      const status = { open: openStatus, clarified, ambiguous, assigned, handled: assigned, done, resolved: done }[item.status] ?? '';
      const name = roles[item.role]?.name ?? t('甲方', 'Client');
      const checkbox = node('input', { attrs: { type: 'checkbox', 'aria-label': t(`选中${name}这条意见`, `Select feedback from ${name}`) } });
      checkbox.checked = pending.has(item.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) pending.add(item.id);
        else pending.delete(item.id);
        combine.disabled = pending.size === 0;
        actions.record('ui.selection', { requirementId: item.id, selected: checkbox.checked });
      });
      const original = session.messages?.find((message) => message.id === item.sourceMessageId);
      return node('article', { className: 'sheet-row' },
        node('div', { className: 'sheet-heading' },
          node('label', { className: 'requirement-check' }, checkbox, document.createTextNode(roles[item.role]?.name ?? t('需求', 'Requirement'))),
          node('span', { className: 'sheet-note', text: deferred ? t('已搁置', 'Deferred') : status })),
        node('p', { text: item.text }),
        ...(original && original.text !== item.text ? [hint(`${t('原话', 'Original quote')} · ${original.text}`)] : []),
        ...(item.condition ? [hint(`${t('条件', 'Condition')} · ${item.condition}`)] : []),
        ...(item.concession ? [hint(`${t('可让步', 'Possible compromise')} · ${item.concession}`)] : []),
        node('div', { className: 'sheet-heading' },
          evidenceButtons(item.elementIds, item.versionId ?? version?.id),
          controls(
            button(deferred ? t('重新处理', 'Reopen') : t('搁置', 'Defer'), async () => {
              const okay = await actions.command('defer', { requirementId: item.id, deferred: !deferred });
              if (okay) feedback();
            }, 'text-button', `requirement:defer:${item.id}`),
            button(t('转交', 'Forward'), () => forward([item]), 'button small', `requirement:forward:${item.id}`)
          )));
    });
    show('feedback', detailHeading, switcher,
      ...(requirementRows.length ? requirementRows : [hint(t('还没有收集到甲方需求。', 'No client requirements have been collected yet.'))]), controls(combine));
  }

  function versions() {
    const session = actions.getSession();
    if (!session) return;
    const rows = [...session.versions].reverse().map((version) => {
      const current = version.id === session.selectedVersionId;
      const select = button(current ? t('正在查看', 'Viewing') : t('查看', 'View'), async () => {
        if (await actions.selectVersion(version.id)) close();
      }, 'button small', `version:select:${version.id}`);
      select.disabled = current;
      return node('article', { className: 'version-item' },
        node('img', { className: 'version-thumb', attrs: { src: versionUrl(session, version.id), alt: '', loading: 'lazy' } }),
        node('div', {},
          node('strong', { text: `${version.id} ${version.label ?? ''}` }),
          ...(version.id === session.finalizedVersionId ? [node('span', { className: 'flag', text: t('已定稿', 'Finalized') })] : []),
          ...(version.parentId ? [hint(t(`源自 ${version.parentId}`, `Based on ${version.parentId}`))] : [])),
        controls(select, button(t('恢复为草稿', 'Restore as draft'), async () => {
          if (await actions.command('restore', { versionId: version.id }, { singleFlight: true })) {
            close();
            actions.notify(t('已恢复为待确认草稿。', 'Restored as a draft for approval.'));
          }
        }, 'button small', `version:restore:${version.id}`)));
    });
    const deliveries = (session.deliveries ?? []).slice().reverse().map((item) => {
      const versionId = item.versionId ?? '';
      const format = String(item.format ?? '').toUpperCase();
      return hint(`${versionId} · ${format}${item.fileName ? ` · ${item.fileName}` : ''}`);
    });
    show('versions', t('版本记录', 'Version history'), ...rows,
      ...(deliveries.length ? [node('h3', { className: 'list-header', text: t('交付记录', 'Delivery history') }), ...deliveries] : []));
  }

  function exportVersion() {
    const version = actions.getVersion();
    if (!version) return;
    const choices = node('div', { className: 'export-options' },
      ...['png', 'svg'].map((format) => button(format.toUpperCase(), async (event) => {
        event.currentTarget.disabled = true;
        const okay = await actions.downloadVersion(version.id, format);
        if (okay) close();
        else if (dialog.open) {
          const option = [...choices.children].find((child) => child.textContent === format.toUpperCase());
          if (option) option.disabled = false;
        }
      }, 'button primary', `export:${format}`)));
    show('export', t(`导出 ${version.id}`, `Export ${version.id}`), choices);
  }

  function finalize() {
    const version = actions.getVersion();
    if (!version) return;
    show('finalize', t(`定稿 ${version.id}`, `Finalize ${version.id}`),
      node('p', { text: version.label ?? t('海报', 'Poster') }),
      controls(button(t('取消', 'Cancel'), close, 'button', 'finalize:cancel'),
        button(t('确认定稿', 'Confirm final version'), async () => {
          if (await actions.command('finalize', { versionId: version.id })) close();
        }, 'button primary', 'finalize:confirm')));
  }

  function discardDraft(draft) {
    const discard = button(t('放弃草稿', 'Discard draft'), async () => {
      discard.disabled = true;
      if (await actions.discardDraft(draft.id)) close();
      else discard.disabled = false;
    }, 'button primary', 'draft:discard');
    show('discard-draft', t('放弃草稿？', 'Discard this draft?'),
      controls(button(t('保留草稿', 'Keep draft'), close), discard));
  }

  function brief() {
    const session = actions.getSession();
    const theme = session?.theme;
    if (!theme) return;
    const description = typeof theme.brief === 'string' ? theme.brief : theme.brief?.summary ?? theme.brief?.description;
    const localMode = t('本地演练', 'Local rehearsal');
    const currentMode = { local: localMode, online: t('在线模式', 'Online'), rehearsal: localMode, auto: t('自动', 'Auto') }[session.mode] ??
      (typeof session.mode === 'string' ? session.mode : localMode);
    show('brief', `${theme.name} · ${t('项目简报', 'Project brief')}`,
      ...(description ? [node('p', { text: description })] : []),
      projectFacts(theme.facts),
      hint(`${theme.width} × ${theme.height} ${t('像素', 'px')} · ${currentMode}`),
      controls(node('a', { className: 'button', text: t('返回项目首页', 'Back to projects'), attrs: { href: '/' } })));
  }

  function settings() {
    const prefs = actions.getPreferences();
    const volumeLabel = node('output', { text: `${Math.round(prefs.volume * 100)}%` });
    const volume = node('input', { attrs: { id: 'volume', type: 'range', min: '0', max: '100', value: String(Math.round(prefs.volume * 100)), 'aria-label': t('语音音量', 'Voice volume') } });
    volume.addEventListener('input', () => {
      const value = Number(volume.value) / 100;
      volumeLabel.value = `${volume.value}%`;
      actions.setPreference('volume', value);
    });
    show('settings', t('语音设置', 'Audio settings'),
      node('label', { className: 'setting-row' }, document.createTextNode(t('音量', 'Volume')), volume, volumeLabel));
  }

  async function canvas() {
    const session = actions.getSession();
    const version = actions.getVersion();
    if (!session || !version) return;
    const draft = session.draft;
    if (draft && draft.baseVersionId !== version.id) {
      actions.notify(t('请先处理另一版海报的草稿。', 'Review the other poster draft first.'), 'error');
      return;
    }
    const mount = node('div', { className: 'vector-canvas-mount' }, hint(t('正在打开画布…', 'Opening the canvas…')));
    show('canvas', t('画布工具', 'Canvas tools'), mount);
    const isOpen = () => dialog.open && currentSheet === 'canvas' && mount.isConnected;
    try {
      const { mountVectorCanvas } = await import('./vector-canvas.js');
      if (!isOpen()) return;
      mount.replaceChildren();
      disposeContent = mountVectorCanvas(mount, {
        width: session.theme.width, height: session.theme.height,
        previewUrl: draft?.previewUrl ?? versionUrl(session, version.id),
        async onSave(calls) {
          if (!isOpen() || actions.getSession()?.id !== session.id) return false;
          const result = await actions.sendCommand('canvasEdit', {
            versionId: version.id, draftId: draft?.id ?? null, calls
          }, { singleFlight: true });
          if (result && isOpen()) close();
          return Boolean(result);
        }
      });
    } catch {
      if (isOpen()) mount.replaceChildren(hint(t('画布加载失败，请重新打开。', 'Could not load the canvas. Open it again.')));
    }
  }

  function recordingNotice() {
    show('voice-consent', t('本局录音', 'Session recording'),
      node('p', { text: t('语音录音和转写会随本局保存，并可在回放中查看。', 'Recordings and transcripts are saved with this session and available in replay.') }),
      controls(button(t('继续打字', 'Keep typing'), close, 'button', 'mic:keep-typing'), button(t('允许本局录音', 'Allow recording for this session'), () => {
        actions.acceptRecording();
        close();
      }, 'button primary', 'mic:allow')));
  }

  function reset() {
    pending = new Set();
    close();
  }

  return {
    close, reset, score, transcript, forward, requirementSource, feedback, versions, exportVersion, finalize, discardDraft, brief, settings,
    recordingNotice, traces, materials, canvas, refresh() { if (dialog.open) updateContent?.(); }, getCurrent: () => currentSheet
  };
}

