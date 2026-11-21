import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiSettingsForm } from './home-settings.jsx';
import { language, t } from './i18n.js';
import { SoundSettings } from './workbench/sound-settings.jsx';
import './app-settings.css';

const settingsLinks = new Set(['/', '/home.html', '/index.html', '/workbench', '/workbench.html']);

function linkedSection() {
  const selected = new URL(location.href).searchParams.get('settings');
  return selected === 'general' ? 'general' : selected === null ? null : 'api';
}

function changeLanguage(event) {
  const url = new URL(location.href);
  url.searchParams.set('settings', 'general');
  url.searchParams.set('lang', event.currentTarget.value);
  location.assign(url.href);
}

export function AppSettings({ triggerClassName, onApiSettings, workflow }) {
  const [section, setSection] = useState(linkedSection);
  const [apiVisited, setApiVisited] = useState(section === 'api');
  const dialog = useRef(null);
  const trigger = useRef(null);

  function open(next) {
    setSection(next);
    if (next === 'api') setApiVisited(true);
  }

  function close() {
    setSection(null);
    setApiVisited(false);
    const url = new URL(location.href);
    if (url.searchParams.has('settings')) {
      url.searchParams.delete('settings');
      history.replaceState(history.state, '', url.href);
    }
    const focused = document.activeElement;
    if (focused === document.body || dialog.current.contains(focused)) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    const element = dialog.current;
    if (section && !element.open) {
      element.showModal();
      element.querySelector('[aria-pressed="true"]')?.focus();
    }
  }, [section]);

  useEffect(() => {
    function followSettingsLink(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.hasAttribute('download')) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || !settingsLinks.has(url.pathname) || !url.searchParams.has('settings')) return;
      // Keep explicit links to a different project or language as regular navigation.
      const current = new URL(location.href);
      if (url.searchParams.has('project') && url.searchParams.get('project') !== current.searchParams.get('project')) return;
      if (url.searchParams.has('lang') && url.searchParams.get('lang') !== language) return;
      event.preventDefault();
      open(url.searchParams.get('settings') === 'general' ? 'general' : 'api');
    }
    document.addEventListener('click', followSettingsLink);
    return () => document.removeEventListener('click', followSettingsLink);
  }, []);

  return <>
    <button ref={trigger} className={triggerClassName} id="appSettingsBtn" type="button"
      aria-haspopup="dialog" aria-controls="appSettingsDialog" onClick={() => open('general')}>
      {t('设置', 'Settings')}
    </button>
    {createPortal(
      <dialog ref={dialog} id="appSettingsDialog" className="app-settings-dialog" data-section={section}
        aria-labelledby="appSettingsTitle" onClose={close}>
        <header className="app-settings-header">
          <h2 id="appSettingsTitle">{t('设置', 'Settings')}</h2>
          <button className="app-settings-close" type="button" onClick={() => dialog.current.close()} aria-label={t('关闭设置', 'Close settings')}>×</button>
        </header>
        <nav className="app-settings-navigation" aria-label={t('设置分类', 'Settings categories')}>
          <button type="button" aria-pressed={section === 'general'} onClick={() => open('general')}>{t('常规', 'General')}</button>
          <button type="button" aria-pressed={section === 'api'} onClick={() => open('api')}>{t('API 设置', 'API settings')}</button>
        </nav>
        <div className="app-settings-content" hidden={section !== 'general'}>
          <label className="app-settings-language">
            {t('语言', 'Language')}
            <select value={language} onChange={changeLanguage}>
              <option value="zh-CN" lang="zh-CN">中文</option>
              <option value="en" lang="en">English</option>
            </select>
          </label>
          <SoundSettings />
          {workflow && <section className="app-settings-workflow" aria-labelledby="appWorkflowHeading">
            <h3 id="appWorkflowHeading">{t('项目工作流', 'Project workflow')}</h3>
            <div className="app-settings-workflow-controls">{workflow}</div>
          </section>}
        </div>
        {apiVisited && <div className="app-settings-content" hidden={section !== 'api'}>
          <ApiSettingsForm onClose={() => dialog.current.close()} onSettings={onApiSettings} />
        </div>}
      </dialog>,
      document.body,
    )}
  </>;
}
