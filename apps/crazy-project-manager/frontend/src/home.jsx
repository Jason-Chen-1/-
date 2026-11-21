import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppSettings } from './app-settings.jsx';
import { requestHome, workbenchUrl } from './home-api.js';
import { HomeDialog } from './home-dialog.jsx';
import { mountHomeMusic } from './home-music.js';
import { language, t } from './i18n.js';
import './studio-fonts.css';
import './home.css';

const dateFormatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
const emptyProject = { topic: '', brief: '', organizer: '', date: '', venue: '' };

function ProjectShelf({ history }) {
  if (history.error) return <p className="archive-empty">{history.error}</p>;
  if (!history.items) return <p>{t('正在读项目档案…', 'Loading project history…')}</p>;
  if (!history.items.length) return <p className="archive-empty">{t('还没有项目。', 'No projects yet.')}</p>;
  const ordered = [...history.items].sort((a, b) => (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt));
  return ordered.map(project => {
    const id = encodeURIComponent(project.id);
    const version = project.selectedVersionId;
    return (
      <a className="project-cover" href={workbenchUrl(project.id)} key={project.id}>
        <span className="project-miniature">
          {version ? <img alt="" loading="lazy" src={`/api/sessions/${id}/versions/${encodeURIComponent(version)}/poster.png`} />
            : <span className="project-miniature-outline" aria-hidden="true"></span>}
        </span>
        <span className="project-summary">
          <strong className="project-name">{project.theme.name}</strong>
          <span className="project-state">
            {project.finalizedVersionId
              ? t(`已定稿 · ${project.finalizedVersionId}`, `Finalized · ${project.finalizedVersionId}`)
              : version ? t(`进行中 · ${version}`, `In progress · ${version}`) : t('初稿未完成', 'First draft pending')}
          </span>
          <span className="project-date">{dateFormatter.format(project.updatedAt ?? project.startedAt)}</span>
        </span>
        <span className="project-arrow" aria-hidden="true">↗</span>
      </a>
    );
  });
}

function CreateDialog({ onClose, onCreate, projectStatus }) {
  const [project, setProject] = useState(emptyProject);
  const [validation, setValidation] = useState('');
  const bind = name => ({
    name, value: project[name],
    onChange: event => {
      setProject(current => ({ ...current, [name]: event.target.value }));
      if (name === 'topic') setValidation('');
    },
  });
  const message = validation || (projectStatus.target === 'create' ? projectStatus.message : '');
  function submit(event) {
    event.preventDefault();
    if (!project.topic.trim()) {
      setValidation(t('请填写项目主题。', 'Enter a project theme.'));
      event.currentTarget.elements.topic.focus();
      return;
    }
    void onCreate(project);
  }
  return (
    <HomeDialog className="create-dialog" id="createDialog" title={t('新建项目', 'New project')} focusSelector="[name=topic]" onClose={onClose}>
      {close => (
        <form id="createForm" className="dialog-inner" onSubmit={submit} noValidate>
          <label className="field title-field">{t('项目主题', 'Project theme')}
            <input {...bind('topic')} maxLength={26} placeholder={t('例如：城市植物交换节', 'e.g. City Plant Swap')} required />
          </label>
          <label className="field">{t('项目简报', 'Project brief')}
            <textarea {...bind('brief')} maxLength={320} rows={3} placeholder={t('一句话说明这张海报要做什么（可选）', 'Describe what the poster needs to do in one sentence (optional)')} />
          </label>
          <details className="extra-facts">
            <summary>{t('补充主办方、时间和地点', 'Add an organizer, date and location')}</summary>
            <div className="fact-fields">
              <label className="field">{t('主办方', 'Organizer')} <input {...bind('organizer')} maxLength={18} /></label>
              <label className="field">{t('时间', 'Date and time')} <input {...bind('date')} maxLength={22} /></label>
              <label className="field">{t('地点', 'Location')} <input {...bind('venue')} maxLength={22} /></label>
            </div>
          </details>
          <p className="form-message" id="createMessage" role="status">{message}</p>
          <div className="dialog-actions">
            <button className="frame-button" type="button" onClick={close}>{t('取消', 'Cancel')}</button>
            <button className="frame-button take-action" type="submit" disabled={projectStatus.pending}>
              {t('创建项目', 'Create project')} <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      )}
    </HomeDialog>
  );
}

function Home() {
  const [history, setHistory] = useState({});
  const [settings, setSettings] = useState(null);
  const [open, setOpen] = useState('');
  const [projectStatus, setProjectStatus] = useState({});
  const creating = useRef(false);
  const settingsRevision = useRef(0);
  const acceptSettings = useCallback(config => {
    settingsRevision.current += 1;
    setSettings(config);
  }, []);

  useEffect(mountHomeMusic, []);

  useEffect(() => {
    let active;
    function load() {
      active?.abort();
      const controller = new AbortController();
      const revision = settingsRevision.current;
      active = controller;
      requestHome('/api/sessions', undefined, controller.signal).then(({ sessions }) => {
        if (!controller.signal.aborted) setHistory({ items: sessions });
      }).catch(error => {
        if (!controller.signal.aborted) setHistory({ error: error.message });
      });
      requestHome('/api/settings', undefined, controller.signal).then(config => {
        if (!controller.signal.aborted && revision === settingsRevision.current) acceptSettings(config);
      }).catch(() => {});
    }
    function restore(event) {
      if (!event.persisted) return;
      creating.current = false;
      setProjectStatus({});
      load();
    }
    load();
    window.addEventListener('pageshow', restore);
    return () => {
      active?.abort();
      window.removeEventListener('pageshow', restore);
    };
  }, [acceptSettings]);

  async function createProject(project) {
    if (creating.current) return;
    creating.current = true;
    const target = project ? 'create' : 'demo';
    setProjectStatus({ target, pending: true, message: t('正在生成初稿并准备甲方意见…', 'Preparing the first draft and client feedback…') });
    try {
      const result = await requestHome('/api/sessions', project ? { project, language } : { language });
      location.assign(workbenchUrl(result.id, true));
    } catch (error) {
      setProjectStatus({ target, message: error.message });
      creating.current = false;
    }
  }

  const summary = settings && [
    settings.agent.available ? 'Agent API' : t('未启用 Agent', 'Agent not configured'),
    settings.tts.available
      ? t(`在线配音 ${settings.tts.activeVoices.length}/4`, `Online voices ${settings.tts.activeVoices.length}/4`)
      : t('未启用 TTS', 'TTS not configured'),
    settings.asr.mode === 'browser' ? t('浏览器识别', 'Browser transcription')
      : settings.asr.available ? t('在线转写', 'Online transcription') : t('未启用转写', 'Transcription not configured'),
  ].join(' · ');
  const demoMessage = projectStatus.target === 'demo' ? projectStatus.message : '';
  return <>
    <header className="home-top">
      <a className="ink-mark" href={`/?lang=${language}`} aria-label={t('疯狂的项目经理首页', 'Crazy Project Manager home')}>{t('乙', 'PM')}</a>
      <nav aria-label={t('主导航', 'Main navigation')}>
        <a href="#projects">{t('项目', 'Projects')} <span aria-hidden="true">↓</span></a>
        <AppSettings triggerClassName="frame-button" onApiSettings={acceptSettings} />
      </nav>
    </header>
    <main className="home-sheet">
      <section className="cover" aria-labelledby="appTitle">
        <div className="cover-ink" aria-hidden="true" />
        <div className="cover-art" aria-hidden="true">
          <span className="cover-actor cover-actor--lin" />
          <span className="cover-actor cover-actor--tang" />
          <span className="cover-actor cover-actor--zhou" />
        </div>
        <div className="cover-copy">
          <h1 id="appTitle" aria-label={t('疯狂的项目经理', 'Crazy Project Manager')}>
            {t(['疯狂的', '项目经理'], ['Crazy', 'Project', 'Manager']).map(word => <span key={word}>{word}</span>)}
          </h1>
          <div className="cover-actions">
            <button className="frame-button new-project" id="openCreate" type="button" disabled={projectStatus.pending} onClick={() => {
              setProjectStatus({});
              setOpen('create');
            }}><span aria-hidden="true">＋</span> {t('新建项目', 'New project')}</button>
            <button className="cover-demo" id="tryDemo" type="button" disabled={projectStatus.pending} onClick={() => void createProject()}>
              {t('体验示例', 'Try the demo')} <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p className="home-error" id="homeError" role="alert" hidden={!demoMessage}>{demoMessage}</p>
        </div>
      </section>
      <section className="archive" id="projects" aria-labelledby="projectsHeading">
        <div className="archive-heading">
          <h2 id="projectsHeading">{t('历史项目', 'Project history')}</h2>
          <span className="service-summary" id="serviceSummary">{summary}</span>
        </div>
        <div className="project-shelf" id="projectShelf" aria-live="polite"><ProjectShelf history={history} /></div>
      </section>
    </main>
    {open === 'create' && <CreateDialog projectStatus={projectStatus} onCreate={createProject} onClose={() => setOpen('')} />}
  </>;
}

document.documentElement.lang = language;
document.title = t('疯狂的项目经理', 'Crazy Project Manager');
createRoot(document.getElementById('root')).render(<Home />);
