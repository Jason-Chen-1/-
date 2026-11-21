import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppSettings } from '../app-settings.jsx';
import { t, withLanguage } from '../i18n.js';
import { mountWorkbench } from './workbench.js';
import '../studio-fonts.css';
import './workbench.css';
import './performance.css';
import './replay.css';
import './manga-workbench.css';

function IconLibrary() {
  return (
    <svg className="icon-library" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>
      <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v5l4 2"/></symbol>
      <symbol id="i-export" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
      <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
      <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
      <symbol id="i-fit" viewBox="0 0 24 24"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/></symbol>
      <symbol id="i-fullscreen" viewBox="0 0 24 24"><path d="M14 4h6v6m0-6-7 7m-3 9H4v-6m0 6 7-7"/></symbol>
      <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/></symbol>
      <symbol id="i-materials" viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z"/></symbol>
      <symbol id="i-dispute" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3zm0 6v5m0 3h.01"/></symbol>
      <symbol id="i-hand" viewBox="0 0 24 24"><path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 5-3 7-7 7-3 0-5-2-7-4l-3-4c-1-2 1-4 3-2l2 2"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></symbol>
    </defs></svg>
  );
}

function handleApiSettings() {
  window.dispatchEvent(new Event('studio-api-settings'));
}

function Topbar() {
  return (
    <header className="topbar">
      <a className="brand back-to-projects" href={withLanguage('/')} aria-label={t('返回项目首页', 'Back to projects')}><span className="brand-mark" aria-hidden="true">{t('乙', 'PM')}</span><span>{t('← 项目', '← Projects')}</span></a>
      <button className="top-project" type="button" id="briefBtn" aria-label={t('查看项目简报', 'Open the project brief')}>
        <svg aria-hidden="true"><use href="#i-file"/></svg><span id="projectName">{t('项目简报', 'Project brief')}</span>
      </button>
      <div className="top-actions">
        <AppSettings triggerClassName="button quiet" onApiSettings={handleApiSettings} workflow={<>
          <button className="button quiet" id="meetingModeBtn" type="button" role="switch" aria-checked="true" disabled>{t('会议模式', 'Meeting mode')} <span id="meetingModeLabel" aria-hidden="true">{t('开', 'On')}</span></button>
          <button className="button quiet" id="meetingApprovalToggle" type="button" role="switch" aria-checked="false" aria-label={t('会议交付需要审批', 'Require approval for meeting delivery')} disabled>{t('审批', 'Approval')} <span id="meetingApprovalLabel" aria-hidden="true">{t('关', 'Off')}</span></button>
          <button className="button quiet" type="button" id="toolTraceBtn">{t('工具调用审计', 'Tool audit')}</button>
        </>} />
        <button className="button small" id="soundEnableBtn" type="button" hidden>{t('启用声音', 'Enable sound')}</button>
        <a className="button quiet" id="onlineSetupLink" href={withLanguage('/?settings=1')} target="_blank" rel="noopener" hidden>{t('配置在线服务', 'Configure online services')}</a>
        <button className="button quiet" type="button" id="replayBtn"><svg aria-hidden="true"><use href="#i-history"/></svg><span>{t('回放', 'Replay')}</span></button>
        <button className="button" type="button" id="finalizeBtn">{t('定稿', 'Finalize')}</button>
        <button className="button primary" type="button" id="exportBtn"><svg aria-hidden="true"><use href="#i-export"/></svg><span id="exportLabel">{t('导出海报', 'Export poster')}</span></button>
      </div>
    </header>
  );
}

const cast = [
  { id: 'zhou', sprite: 'boss', name: t('周总', 'Zhou'), position: t('老板', 'Director') },
  { id: 'lin', sprite: 'brand-person', name: t('林尺', 'Lin Chi'), position: t('品牌', 'Brand') },
  { id: 'tang', sprite: 'client-person', name: t('阿唐', 'A-Tang'), position: t('活动', 'Events') }
];

const TranscriptRound = memo(function TranscriptRound({ round, selected }) {
  return (
    <section className="meeting-transcript-round" data-round-id={round.id} data-selected-version={selected ? 'true' : undefined}>
      <h3>{round.label}</h3>
      {round.lines.map(line => <div className="meeting-transcript-turn" key={line.id}>
        <p data-streaming={line.streaming ? 'true' : undefined}>{line.text}</p>
        {line.feedback && <div className="review-return">
          <strong>{t('经理已退回', 'Returned by manager')}</strong>
          {line.feedback.text && <span>{line.feedback.text}</span>}
        </div>}
      </div>)}
    </section>
  );
});

const ClientCard = memo(function ClientCard({ actor, index, group, roundKey, selectedVersionId, viewSource, forward, retry }) {
  const scroll = useRef(null);
  const following = useRef(true);
  const { items = [], history = [], meeting = true, failures = [], awaiting = false, phase = '', phaseLabel = '' } = group ?? {};
  useLayoutEffect(() => {
    following.current = true;
    if (scroll.current) scroll.current.scrollTop = meeting ? scroll.current.scrollHeight : 0;
  }, [roundKey, meeting]);
  useLayoutEffect(() => {
    if (meeting && following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [history, phaseLabel, failures, meeting]);
  const transcript = history.length ? <div className="meeting-transcript">
    {history.map(round => <TranscriptRound key={round.id} round={round} selected={round.versionId === selectedVersionId} />)}
  </div> : null;
  return (
    <div className="cast-frame" data-role={actor.id} data-review-phase={phase}>
      <button className="cast-person" type="button" data-person={index} data-role={actor.id} data-performer={actor.id} aria-pressed="false" disabled={phase === 'waiting-poster'}>
        <span className={`cast-sprite ${actor.sprite}`} aria-hidden="true"></span>
        <span className="cast-name">{actor.name} <small>{actor.position}</small></span>
      </button>
      <section className="cast-needs" ref={scroll} data-needs-role={actor.id} tabIndex={items.length || history.length || failures.length ? 0 : undefined}
        aria-label={meeting ? t(`${actor.name}的会议发言`, `${actor.name}'s meeting remarks`) : t(`${actor.name}本轮需求`, `${actor.name}'s requests this round`)}
        onScroll={(event) => { const panel = event.currentTarget; following.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 25; }}>
        {phaseLabel && <p className="cast-review-status">{phaseLabel}</p>}
        {failures.map((failure) => (
          <div className="online-failure" key={failure.id}>
            <strong role="status">{failure.label}</strong>
            {failure.message && <p>{failure.message}</p>}
            {failure.text && <p className="online-failure-quote">{failure.text}</p>}
            <div className="online-failure-actions">
              {failure.settings && <a href={withLanguage('/?settings=1')} target="_blank" rel="noopener">{failure.settings}</a>}
              {failure.actionLabel && <button type="button" className="button small" onClick={() => retry(failure)} disabled={failure.busy}>{failure.actionLabel}</button>}
            </div>
          </div>
        ))}
        {meeting ? (transcript ?? (roundKey && !phaseLabel && !failures.length && <p className="round-need-empty">{t('等待会议发言', 'Waiting for meeting remarks')}</p>)) : items.length ? (
          <ul className="cast-need-list">
            {items.map((item) => (
              <li data-requirement-id={item.id} key={item.id}>
                <p>{item.text}</p>
                <div className="round-need-actions">
                  {item.source && <button type="button" className="text-button" data-record={`round-needs:source:${item.id}`} onClick={() => viewSource(item)}>{t('原话', 'Quote')}</button>}
                  <button type="button" className="text-button" data-record={`round-needs:forward:${item.id}`} onClick={() => forward(item)}>{t('转小乙', 'Forward')}</button>
                </div>
              </li>
            ))}
          </ul>
        ) : roundKey && !phaseLabel && !failures.length && <p className="round-need-empty">{awaiting ? t('等待发言', 'Waiting to speak') : t('本轮暂无需求', 'No requests this round')}</p>}
        {!meeting && transcript && <details className="cast-history"><summary>{t('评审历史', 'Review history')}</summary>{transcript}</details>}
      </section>
      <div className="cast-score-slot" data-score-slot={actor.id}></div>
    </div>
  );
});

function Clients({ needs }) {
  const { roundKey, selectedVersionId, groups, viewSource, forward, retry } = useSyncExternalStore(needs.subscribe, needs.getSnapshot);
  return (
    <aside className="clients panel" aria-labelledby="clientHeading">
        <h2 className="sr-only" id="clientHeading">{t('甲方评审', 'Client review')}</h2>
        <div className="meeting-stage" id="meetingStage">
          <div className="cast-row" id="clientCards" role="group" aria-label={t('三位甲方的需求与满意度', 'Client requests and satisfaction')}>
            {cast.map((actor, index) => (
              <ClientCard key={actor.id} actor={actor} index={index} group={groups.find(({ role }) => role === actor.id)}
                roundKey={roundKey} selectedVersionId={selectedVersionId} viewSource={viewSource} forward={forward} retry={retry} />
            ))}
          </div>
        </div>
      </aside>
  );
}

function Canvas() {
  return (
    <section className="canvas-panel" aria-label={t('海报工作区', 'Poster workspace')}>
        <div className="canvas-top">
          <div className="canvas-tabs" role="tablist" aria-label={t('画布视图', 'Poster views')}>
            <button className="tab" id="previewTab" type="button" role="tab" aria-controls="posterWrap" aria-selected="true">{t('预览', 'Preview')}</button>
            <button className="tab" id="compareTab" type="button" role="tab" aria-controls="comparison" aria-selected="false">{t('对比', 'Compare')}</button>
          </div>
          <div className="canvas-actions">
            <button className="icon-button" id="posterFullscreenBtn" type="button" aria-label={t('全屏预览', 'Full-screen preview')} aria-haspopup="dialog" aria-controls="posterFullscreen" title={t('全屏预览', 'Full-screen preview')} disabled><svg aria-hidden="true"><use href="#i-fullscreen"/></svg></button>
            <button className="icon-button" id="historyBtn" type="button" aria-label={t('历史版本', 'Version history')} title={t('历史版本', 'Version history')}><svg aria-hidden="true"><use href="#i-history"/></svg></button>
          </div>
        </div>
        <div className="canvas-meta">
          <span className="version-title"><strong id="versionName"></strong><span className="flag draft-flag" id="draftFlag" role="status" hidden>{t('草稿', 'Draft')}</span><span className="flag" id="finalizedFlag" hidden>{t('定稿', 'Final')}</span></span>
          <span className="canvas-size" id="canvasSize"></span>
          <button className="icon-button dispute" id="resolveConflict" type="button" hidden><svg aria-hidden="true"><use href="#i-dispute"/></svg><span id="disputeCount" aria-hidden="true"></span></button>
        </div>
        <div className="artboard" id="artboard" tabIndex={0} aria-label={t('海报视图', 'Poster viewing area')}>
          <div className="artboard-inner">
            <div className="initial-poster" id="initialPoster" role="status">
              <strong id="initialPosterStatus">{t('正在打开项目…', 'Opening project…')}</strong>
              <div className="initial-poster-progress" id="initialPosterProgress" hidden>
                <progress id="initialPosterBar" max="100" value="0" aria-label={t('初稿进度', 'First draft progress')}></progress>
                <span id="initialPosterPercent" aria-hidden="true"></span>
              </div>
            </div>
            <div className="poster-wrap" id="posterWrap" role="tabpanel" aria-labelledby="previewTab" hidden>
              <img id="poster" alt={t('项目海报', 'Project poster')} decoding="async" />
              <div id="elementOverlay" hidden></div>
            </div>
            <div className="comparison" id="comparison" role="tabpanel" aria-labelledby="compareTab" hidden>
              <div className="compare-piece">
                <label><span className="sr-only">{t('对比基准', 'Comparison base')}</span><select id="compareVersion"></select></label>
                <img id="beforeArt" alt={t('对比基准海报', 'Base poster')} decoding="async" />
              </div>
              <div className="compare-piece">
                <strong id="afterLabel"></strong>
                <img id="afterArt" alt={t('选中版本海报', 'Selected poster version')} decoding="async" />
              </div>
            </div>
          </div>
        </div>
        <div className="canvas-bottom">
          <div className="canvas-file">
            <button className="icon-button" type="button" id="uploadBtn" aria-label={t('上传主视觉', 'Upload artwork')} title={t('上传主视觉', 'Upload artwork')}><svg aria-hidden="true"><use href="#i-upload"/></svg></button>
            <input id="uploadInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml" hidden />
            <button className="icon-button" type="button" id="importMaterialBtn" aria-label={t('素材库', 'Materials')} title={t('素材库', 'Materials')}><svg aria-hidden="true"><use href="#i-materials"/></svg></button>
          </div>
          <div className="zoom-controls" aria-label={t('画布缩放', 'Poster zoom')}>
            <button className="icon-button" id="zoomOut" type="button" aria-label={t('缩小', 'Zoom out')}><svg aria-hidden="true"><use href="#i-minus"/></svg></button>
            <span id="zoomLabel">{t('适应', 'Fit')}</span>
            <button className="icon-button" id="zoomIn" type="button" aria-label={t('放大', 'Zoom in')}><svg aria-hidden="true"><use href="#i-plus"/></svg></button>
            <button className="icon-button" id="fitBtn" type="button" aria-label={t('适应画布', 'Fit poster')} title={t('适应画布', 'Fit poster')}><svg aria-hidden="true"><use href="#i-fit"/></svg></button>
          </div>
        </div>
      </section>
  );
}

function MeetingAssignment() {
  return (
    <section className="meeting-assignment" id="meetingAssignment" aria-labelledby="meetingAssignmentHeading" hidden>
      <div className="meeting-assignment-heading">
        <h3 id="meetingAssignmentHeading">{t('待转交的评审意见', 'Review feedback')}</h3>
        <span id="meetingAssignmentRound"></span>
      </div>
      <ul id="meetingAssignmentFeedback" tabIndex={0} aria-labelledby="meetingAssignmentHeading meetingAssignmentRound"></ul>
      <p id="meetingAssignmentWaiting" role="status" hidden>{t('等待小乙接手', 'Waiting for Xiao Yi')}</p>
      <button className="button primary small release-meeting-btn" id="releaseMeetingBtn" type="button" disabled hidden>{t('将本轮意见交给小乙', 'Send feedback to Xiao Yi')}</button>
    </section>
  );
}

function Employee() {
  return (
    <aside className="agent-panel panel" id="agentPanel" aria-labelledby="employeeHeading">
        <div className="section-title"><h2 id="employeeHeading">{t('小乙', 'Xiao Yi')}</h2><span className="agent-role">{t('执行设计师', 'Designer')}</span></div>
        <div className="agent-stage" id="agentStage" data-performer="yi">
          <span className="agent-caption" id="agentCaption">{t('等你派工。', 'Ready for an assignment.')}</span>
          <span className="employee-sprite" role="img" aria-label={t('戴橙色耳机的小乙', 'Xiao Yi in orange headphones')}></span>
          <svg className="mascot" viewBox="0 0 240 150" aria-hidden="true" hidden>
            <ellipse cx="120" cy="139" rx="65" ry="6" fill="#dcdcd5"/>
            <g className="mascot-body">
              <path d="M76 92 60 117M164 92l17 25" stroke="#232725" strokeWidth="9" strokeLinecap="round"/>
              <path d="M93 120v17m54-17v17" stroke="#232725" strokeWidth="10" strokeLinecap="round"/>
              <rect x="74" y="35" width="92" height="92" rx="29" fill="#ff865c"/>
              <path d="M87 40c0-25 66-25 66 0" fill="none" stroke="#252a27" strokeWidth="8"/>
              <rect x="67" y="49" width="14" height="35" rx="7" fill="#252a27"/>
              <rect x="159" y="49" width="14" height="35" rx="7" fill="#252a27"/>
              <rect x="90" y="57" width="60" height="38" rx="16" fill="#ffbd94"/>
              <g className="eyes"><path d="M105 69v10m30-10v10" stroke="#272a27" strokeWidth="6" strokeLinecap="round"/></g>
              <path id="smile" d="M112 88q8 7 16 0" fill="none" stroke="#272a27" strokeWidth="3" strokeLinecap="round"/>
              <path d="M169 79v17q0 7-17 7" fill="none" stroke="#252a27" strokeWidth="4"/>
              <rect x="142" y="99" width="14" height="7" rx="3" fill="#252a27"/>
              <path d="m114 113 6-7 6 7-6 7Z" fill="#fef0d3"/>
            </g>
            <g className="coffee"><path d="M187 116h20v20h-20z" fill="#fdfcf6" stroke="#272a27" strokeWidth="2"/><path d="M207 120q13 0 0 11m-14-21q-4-5 0-9" fill="none" stroke="#272a27" strokeWidth="2"/></g>
          </svg>
          <button className="desk-hit" id="deskHit" type="button" aria-label={t('拍桌催稿', 'Bang the desk')} title={t('拍桌催稿', 'Bang the desk')}></button>
          <div className="agent-status" id="agentStatus" aria-live="polite">{t('待命', 'Ready')}</div>
        </div>
        <div className="nudge-buttons">
          <button className="button slap-btn" id="slapBtn" type="button" aria-keyshortcuts="Space" title={t('拍桌催稿（空格键）', 'Bang the desk (Space)')}><svg aria-hidden="true"><use href="#i-hand"/></svg>{t('拍桌催稿', 'Bang the desk')}</button>
          <button className="button mic-button" id="voiceBtn" type="button" title={t('按住录音，松手发送', 'Hold to record, release to send')}><svg aria-hidden="true"><use href="#i-mic"/></svg><span>{t('按住说话', 'Hold to talk')}</span></button>
        </div>
        <MeetingAssignment />
        <div className="work-progress" id="workProgress" hidden>
          <div className="progress-header"><span id="taskLabel"></span><strong id="taskPercent"></strong></div>
          <progress id="taskBar" aria-label={t('工单进度', 'Assignment progress')} max="100" value="0"></progress>
          <button className="text-button" id="retryJob" type="button" hidden>{t('重试工单', 'Retry assignment')}</button>
          <a id="jobSetupLink" href={withLanguage('/?settings=1')} target="_blank" rel="noopener" hidden>{t('配置 Agent', 'Configure Agent')}</a>
        </div>
        <div id="employeeSpeechFailure" hidden></div>
        <div className="chat-scroll" id="chat" role="log" aria-label={t('小乙的对话', 'Conversation with Xiao Yi')} aria-live="polite"></div>
        <section className="draft-approval" id="draftApproval" aria-labelledby="draftApprovalHeading" hidden>
          <div className="draft-approval-heading"><strong id="draftApprovalHeading">{t('草稿', 'Draft')}</strong><span id="draftApprovalDetail"></span></div>
          <div className="draft-approval-actions">
            <button className="button primary small" id="confirmDraftBtn" type="button">{t('确认生成版本', 'Approve and create version')}</button>
            <button className="button small" id="continueDraftBtn" type="button">{t('继续修改', 'Keep editing')}</button>
            <button className="text-button small" id="discardDraftBtn" type="button">{t('放弃草稿', 'Discard draft')}</button>
          </div>
        </section>
        <form id="chatForm" className="composer">
          <label className="sr-only" htmlFor="chatInput">{t('给小乙的工单', 'Assignment for Xiao Yi')}</label>
          <textarea id="chatInput" name="instruction" rows="2" maxLength="1600" placeholder={t('给小乙派工', 'Assign a change to Xiao Yi')}></textarea>
          <div className="composer-bottom"><span className="draft-basis" id="draftBasis"></span><button className="text-button small" id="cancelMeetingDraft" type="button" hidden>{t('取消语音草稿', 'Cancel transcript')}</button><button type="submit" className="button primary small">{t('发送', 'Send')}</button></div>
        </form>
      </aside>
  );
}

function Dialogs() {
  return (
    <>
    <div className="cast-breakout" id="castBreakout" aria-hidden="true" hidden>
      <div className="cast-breakout-flash"></div>
      <div className="cast-breakout-gesture"></div>
      <p className="cast-breakout-bubble" id="castBreakoutText"></p>
    </div>
    <div className="sr-only" id="castAnnouncements" aria-live="polite" aria-atomic="true"></div>
    <div className="connection-notice" id="connectionNotice" role="status" hidden></div>
    <dialog id="modal" aria-labelledby="modalTitle">
      <div className="modal-head"><h2 id="modalTitle"></h2><button className="button icon-button" type="button" id="closeModal" aria-label={t('关闭', 'Close')}><svg aria-hidden="true"><use href="#i-x"/></svg></button></div>
      <div id="modalBody"></div>
    </dialog>
    <dialog className="poster-fullscreen" id="posterFullscreen" aria-labelledby="posterFullscreenTitle" aria-describedby="posterFullscreenVersion">
      <div className="poster-fullscreen-surface">
        <header className="poster-fullscreen-toolbar">
          <div className="poster-fullscreen-heading">
            <h2 id="posterFullscreenTitle">{t('海报预览', 'Poster preview')}</h2>
            <span id="posterFullscreenVersion"></span>
          </div>
          <button className="button small" id="posterFullscreenClose" type="button"><svg aria-hidden="true"><use href="#i-x"/></svg>{t('退出全屏', 'Exit full screen')}</button>
        </header>
        <div className="poster-fullscreen-art">
          <img id="posterFullscreenImage" alt="" decoding="async" hidden />
          <p id="posterFullscreenStatus" role="status" hidden></p>
        </div>
      </div>
    </dialog>
    <div className="toast" id="toast" role="status" hidden></div>
    </>
  );
}

function createRoundStore() {
  let snapshot = { roundKey: '', groups: [] };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(value) {
      snapshot = value;
      for (const listener of listeners) listener();
    }
  };
}

export default function Workbench() {
  const [needs] = useState(createRoundStore);
  useEffect(() => {
    void mountWorkbench({ presentNeeds: needs.publish });
  }, [needs]);
  return (
    <>
      <IconLibrary />
      <Topbar />
      <main className="workspace">
        <Clients needs={needs} />
        <Canvas />
        <Employee />
      </main>
      <Dialogs />
    </>
  );
}
