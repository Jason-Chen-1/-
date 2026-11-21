import { useSyncExternalStore } from 'react';
import { getAudioPreferences, setAudioPreference, subscribeAudioPreferences } from '../audio-preferences.js';
import { t } from '../i18n.js';
import './sound-settings.css';

function Level({ name, label, value }) {
  const id = `audio-${name}`;
  const percent = Math.round(value * 100);
  return <div className="sound-level">
    <input id={id} type="range" min="0" max="100" aria-label={label} value={percent}
      onChange={event => setAudioPreference(name, event.currentTarget.valueAsNumber / 100)} />
    <output htmlFor={id}>{percent}%</output>
  </div>;
}

export function SoundSettings() {
  const preferences = useSyncExternalStore(subscribeAudioPreferences, getAudioPreferences);
  const toggle = name => ({ checked: preferences[name], onChange: event => setAudioPreference(name, event.currentTarget.checked) });
  return <section className="app-settings-audio" aria-labelledby="appAudioHeading">
    <h3 id="appAudioHeading">{t('声音', 'Sound')}</h3>
    <label className="sound-choice sound-mute">{t('全部静音', 'Mute all')}
      <input {...toggle('muted')} type="checkbox" role="switch" />
    </label>
    <div className="sound-channel">
      <label className="sound-choice" htmlFor="audio-volume">{t('角色语音', 'Voices')}</label>
      <Level name="volume" label={t('角色语音音量', 'Voice volume')} value={preferences.volume} />
    </div>
    <div className="sound-channel">
      <label className="sound-choice">{t('背景音乐', 'Background music')}
        <input {...toggle('musicEnabled')} type="checkbox" role="switch" />
      </label>
      <Level name="musicVolume" label={t('背景音乐音量', 'Music volume')} value={preferences.musicVolume} />
    </div>
    <div className="sound-channel">
      <label className="sound-choice">{t('音效', 'Sound effects')}
        <input {...toggle('effectsEnabled')} type="checkbox" role="switch" />
      </label>
      <Level name="effectsVolume" label={t('音效音量', 'Effects volume')} value={preferences.effectsVolume} />
    </div>
  </section>;
}
