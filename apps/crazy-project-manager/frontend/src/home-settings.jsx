import { useEffect, useState } from 'react';
import { requestHome } from './home-api.js';
import { t } from './i18n.js';

const roleNames = { zhou: t('周总', 'Zhou'), lin: t('林尺', 'Lin Chi'), tang: t('阿唐', 'Tang'), yi: t('小乙', 'Xiaoyi') };
const modes = {
  agent: [
    ['local', t('未启用 Agent', 'Agent not configured')],
    ['opencode-go', 'OpenCode Go · HY4 Flash Free'],
    ['api', 'Chat Completions API'],
  ],
  vision: [
    ['inherit', t('与 Agent 共用模型', 'Use the Agent model')],
    ['off', t('使用 Agent 看图', 'Use the Agent for image review')],
    ['api', t('独立视觉 API', 'Separate vision API')],
  ],
  tts: [
    ['local', t('未启用 TTS', 'TTS not configured')],
    ['openrouter', 'OpenRouter · HeyGen Turbo (free)'],
    ['fish', t('Fish 兼容 API', 'Fish-compatible API')],
    ['volcengine', t('火山引擎 · 豆包语音 2.0', 'Volcengine · Doubao Voice 2.0')],
  ],
  asr: [
    ['browser', t('浏览器语音识别', 'Browser speech recognition')],
    ['fish', t('Fish 流式识别 API', 'Fish streaming API')],
    ['volcengine', t('豆包 · 实时识别', 'Doubao · Realtime recognition')],
    ['volcengine-sentence', t('豆包 · 一句话识别', 'Doubao · Sentence recognition')],
    ['volcengine-flash', t('火山 · 极速录音（兼容）', 'Volcengine · Flash recording (legacy)')],
  ],
  image: [
    ['off', t('关闭', 'Off')],
    ['amd', 'AMD Creative Hub'],
  ],
};
const sentenceEndpoint = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const sentenceResources = [
  ['volc.seedasr.sauc.duration', t('小时版', 'Hourly')],
  ['volc.seedasr.sauc.concurrent', t('并发版', 'Concurrent')],
];
const imageAspectRatios = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const fishModels = ['s2.1-pro', 's2-pro', 's2.1-pro-free'];
const volcVoices = {
  zh_male_m191_uranus_bigtts: t('云舟 2.0', 'Yunzhou 2.0'),
  zh_female_xiaohe_uranus_bigtts: t('小何 2.0', 'Xiaohe 2.0'),
  zh_male_yangguangqingnian_uranus_bigtts: t('阳光青年 2.0', 'Bright Young Man 2.0'),
  zh_male_taocheng_uranus_bigtts: t('小天 2.0', 'Xiaotian 2.0'),
};
const guidance = {
  agent: {
    local: t('选择 Agent 服务以生成初稿和评审。', 'Choose an Agent service for drafts and reviews.'),
    'opencode-go': t('HY4 Flash Free 支持看 PNG。', 'HY4 Flash Free supports PNG input.'),
    api: t('使用自定义模型。', 'Uses your configured model.'),
  },
  vision: {
    off: t('评审会将同一版的 PNG 发给 Agent。', 'The Agent receives the PNG for the current revision.'),
    inherit: t('评审沿用 Agent 的模型配置。', 'Reviews reuse the Agent model settings.'),
    api: t('独立视觉模型读取 PNG。', 'A separate model reads the PNG.'),
  },
  asr: {
    browser: t('浏览器识别', 'Browser speech recognition'),
    fish: t('Fish 实时语音识别', 'Fish real-time speech recognition'),
    volcengine: t('按住录音时实时识别。', 'Transcribes while you speak.'),
    'volcengine-sentence': t('松手后返回整句转写。', 'Transcribes the whole sentence after you release the mic.'),
    'volcengine-flash': t('工作台实时识别，录音文件接口需要极速版权限。', 'Workbench uses realtime recognition. The recording file endpoint requires Flash access.'),
  },
};

function providerOf(settings, name, mode) {
  const service = settings?.[name];
  if (name === 'vision') return mode === 'api' ? service?.custom : service;
  if (name === 'image') return service;
  return service?.providers?.[mode] ?? (service?.mode === mode ? service : undefined);
}

function makeForm(settings) {
  return Object.fromEntries(Object.keys(modes).map(name => {
    const mode = settings?.[name]?.mode ?? modes[name][0][0];
    return [name, formSection(settings, name, mode)];
  }));
}

function formSection(settings, name, mode) {
  const provider = providerOf(settings, name, mode);
  const voices = Object.fromEntries(Object.keys(roleNames).map(role => [role, provider?.voices?.[role] ?? '']));
  return {
    mode,
    url: provider?.url ?? '',
    model: provider?.model ?? '',
    queryUrl: provider?.queryUrl ?? '',
    ...(name === 'asr' && mode === 'volcengine-sentence' && { resourceId: provider?.resourceId ?? sentenceResources[0][0] }),
    key: '',
    clearKey: false,
    voices,
  };
}

function writableSections(settings) {
  if (!settings || settings.writable === false) return [];
  const sections = Object.keys(modes).filter(name => name !== 'image' || settings.image);
  if (settings.scope !== 'shared') return sections;
  if (settings.writable !== true || !Array.isArray(settings.writableServices)) return [];
  return sections.filter(name => name !== 'vision' && settings.writableServices.includes(name));
}

function servicePayload(name, data, shared) {
  const sentence = name === 'asr' && data.mode === 'volcengine-sentence';
  if (!shared && name !== 'image' && !sentence) return data;
  const fields = { mode: data.mode };
  if (data.mode === 'local' || data.mode === 'browser' || data.mode === 'off') return fields;
  if (data.clearKey) fields.clearKey = true;
  else if (data.key.trim()) fields.key = data.key.trim();
  if (name === 'agent' && data.mode === 'api') {
    fields.url = data.url.trim();
    fields.model = data.model.trim();
  }
  if (name === 'tts') {
    fields.voices = data.voices;
    if (data.mode === 'fish') fields.model = data.model;
  }
  if (sentence) fields.resourceId = data.resourceId;
  return fields;
}

async function requestSharedSettings(key, data) {
  const headers = { 'X-Studio-Settings-Key': key };
  const signal = AbortSignal.timeout(8000);
  let response;
  try {
    response = await fetch('/api/settings', {
      method: data ? 'POST' : 'GET', cache: 'no-store', redirect: 'error', signal,
      headers: data ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new Error(signal.aborted
      ? t('请求已超时，请重试。', 'The request timed out. Try again.')
      : t('无法连接工作台。', 'Could not reach the workspace.'));
  }
  const result = await response.json().catch(() => null);
  if (response.ok && result) return result;
  const denied = response.status === 401 || response.status === 403;
  const message = denied ? t('管理员密钥无效，请重新解锁。', 'The administrator key is invalid. Unlock again.')
    : t(result?.error || '无法更新全站 API 设置。', 'Could not update site-wide API settings.');
  const error = new Error(message);
  error.denied = denied;
  throw error;
}

function TextField({ label, value, onEdit, ...props }) {
  return <label className="field">{label}<input value={value} onChange={event => onEdit?.(event.target.value)} {...props} /></label>;
}

function ModeField({ name, data, onMode, disabled }) {
  return (
    <label className="field">{name === 'vision' ? t('视觉评审', 'Vision review') : t('模式', 'Mode')}
      <select name="mode" value={data.mode} disabled={disabled} onChange={event => onMode(event.target.value)}>
        {modes[name].map(([value, label]) => <option key={value} value={value} disabled={value === 'local' || (value === 'off' && name !== 'image')}>{label}</option>)}
      </select>
    </label>
  );
}

function KeyFields({ data, saved, optional, disabled, onEdit }) {
  const placeholder = saved ? t('已保存，留空保留', 'Saved. Leave blank to keep it')
    : optional ? t('接口需要时填写', 'Enter if required by the API') : t('填入服务密钥', 'Enter a service key');
  return <>
    <TextField
      label={t('API 密钥', 'API key')}
      name="key"
      type="password"
      autoComplete="new-password"
      placeholder={placeholder}
      disabled={disabled}
      value={data.key}
      onEdit={key => onEdit({ key, clearKey: false })}
    />
    {saved && (
      <label className="key-clear">
        <input
          type="checkbox"
          name="clearKey"
          disabled={disabled}
          checked={data.clearKey}
          onChange={event => onEdit({ clearKey: event.target.checked })}
        />{t('清除现有密钥', 'Clear saved key')}
      </label>
    )}
  </>;
}

function VoiceFields({ data, voiceIds, onEdit }) {
  const preset = data.mode === 'openrouter';
  const volcengine = data.mode === 'volcengine';
  const label = preset ? t('HeyGen 角色音色', 'HeyGen character voices')
    : volcengine ? t('豆包 2.0 角色音色', 'Doubao 2.0 character voices') : t('Fish 角色音色 ID', 'Fish character voice IDs');
  return (
    <div className="voice-fields" aria-label={label} data-tts-mode={data.mode}>
      {Object.entries(roleNames).map(([role, name]) => {
        const update = value => onEdit({ voices: { ...data.voices, [role]: value } });
        return preset ? (
          <label className="field" key={role}>
            {t(`${name}音色`, `${name} voice`)}
            <select name={`router-${role}`} value={data.voices[role]} onChange={event => update(event.target.value)}>
              {voiceIds.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        ) : (
          <TextField
            key={role}
            label={volcengine ? t(`${name}音色`, `${name} voice`) : t(`${name}音色 ID`, `${name} voice ID`)}
            name={volcengine ? `volc-${role}` : role}
            list={volcengine ? 'volcVoices' : undefined}
            value={data.voices[role]}
            onEdit={update}
          />
        );
      })}
      {volcengine && <datalist id="volcVoices">
        {Object.entries(volcVoices).map(([id, title]) => <option key={id} value={id} label={title} />)}
      </datalist>}
    </div>
  );
}

function SynthesisFields({ data, provider, voiceIds, fixedEndpoints, onEdit }) {
  if (data.mode === 'local') return <output className="service-state">{t('选择 TTS 服务以播放角色台词。', 'Choose a TTS service to play character dialogue.')}</output>;
  const count = Object.values(provider?.voices ?? {}).filter(Boolean).length;
  const ready = provider?.hasKey && count;
  return <>
    <div id="ttsRemote">
      <TextField
        label={t('合成地址', 'Synthesis endpoint')}
        name="url"
        type="url"
        value={data.url}
        readOnly={fixedEndpoints}
        onEdit={fixedEndpoints ? undefined : url => onEdit({ url })}
      />
      {data.mode === 'fish' ? (
        <label className="field">{t('模型', 'Model')}
          <select name="model" value={data.model} onChange={event => onEdit({ model: event.target.value })}>
            {fishModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      ) : (
        <TextField
          label={data.mode === 'volcengine' ? t('资源 ID', 'Resource ID') : t('模型', 'Model')}
          name={data.mode === 'volcengine' ? 'volcModel' : 'routerModel'}
          value={data.model}
          readOnly
        />
      )}
      <KeyFields data={data} saved={provider?.hasKey} onEdit={onEdit} />
      <VoiceFields data={data} voiceIds={voiceIds} onEdit={onEdit} />
    </div>
    <output className="service-state">
      {ready ? t(`密钥已保存 · ${count}/4 角色音色`, `Key saved · ${count}/4 voices`)
        : t('等待 API 密钥和角色音色', 'API key and voices needed')}
    </output>
  </>;
}

function VisionSettings({ data, settings, locked, onEdit, onMode }) {
  const provider = providerOf(settings, 'vision', data.mode);
  return (
    <details className="vision-advanced" data-service="vision">
      <summary>{t('高级视觉设置', 'Advanced vision settings')}</summary>
      <ModeField name="vision" data={data} onMode={onMode} disabled={locked} />
      {data.mode === 'api' && <>
        <TextField
          label={t('完整接口地址', 'Full endpoint URL')}
          name="url"
          type="url"
          placeholder="https://…/v1/chat/completions"
          value={data.url}
          disabled={locked}
          onEdit={url => onEdit({ url })}
        />
        <TextField
          label={t('视觉模型 ID', 'Vision model ID')}
          name="model"
          value={data.model}
          disabled={locked}
          onEdit={model => onEdit({ model })}
        />
        <KeyFields data={data} saved={provider?.hasKey} optional disabled={locked} onEdit={onEdit} />
      </>}
      <output className="service-state">{guidance.vision[data.mode]}</output>
    </details>
  );
}

function ImageSettings({ data, provider, locked, onEdit, onMode }) {
  const enabled = data.mode === 'amd';
  const enteredKey = Boolean(data.key.trim());
  const needsKey = data.clearKey || (!provider.hasKey && !enteredKey);
  const pending = data.mode !== provider.mode || enteredKey;
  let status;
  if (needsKey) status = t('需要 API 密钥', 'API key required');
  else if (pending) status = t('保存后生效', 'Save to apply');
  else status = provider.available ? t('可用', 'Ready') : t('不可用', 'Unavailable');
  const ratios = Array.isArray(provider.aspectRatios) ? provider.aspectRatios : imageAspectRatios;

  return (
    <fieldset className="image-settings" data-service="image" data-mode={data.mode} disabled={locked}>
      <legend>{t('图片生成', 'Image generation')} {enabled && <span>{provider.modelLabel || 'Qwen-Image 2.1 Turbo'}</span>}</legend>
      <div className="image-settings-fields">
        <ModeField name="image" data={data} onMode={onMode} />
        {enabled && <div className="image-settings-key"><KeyFields data={data} saved={provider.hasKey} onEdit={onEdit} /></div>}
      </div>
      {enabled && <div className="service-state">
        {t('文生图与参考图编辑', 'Text-to-image and reference-image editing')} · {ratios.join(' / ')} · <output>{status}</output>
      </div>}
    </fieldset>
  );
}

function ServiceFieldset({ name, legend, description, data, settings, locked, fixedEndpoints, onEdit, onMode, children }) {
  const provider = providerOf(settings, name, data.mode);
  const editable = data.mode !== 'local' && data.mode !== 'browser';
  const go = name === 'agent' && data.mode === 'opencode-go';
  const recognition = name === 'asr';
  const sentence = recognition && data.mode === 'volcengine-sentence';
  const recordingEndpoint = recognition && ['volcengine', 'volcengine-flash'].includes(data.mode);
  const addressLabel = recordingEndpoint ? t('录音文件接口', 'Recording file endpoint') : recognition
    ? t('识别地址', 'Recognition endpoint') : t('完整接口地址', 'Full endpoint URL');
  return (
    <fieldset data-service={name} disabled={locked}>
      <legend>{legend} <span>{description}</span></legend>
      <ModeField name={name} data={data} onMode={onMode} />
      {name === 'tts' ? (
        <SynthesisFields data={data} provider={provider} voiceIds={settings?.tts?.voiceIds ?? []} fixedEndpoints={fixedEndpoints} onEdit={onEdit} />
      ) : <>
        <TextField
          label={addressLabel}
          name="url"
          type="url"
          value={sentence ? provider?.url || sentenceEndpoint : data.url}
          placeholder={recognition ? undefined : 'https://…/v1/chat/completions'}
          disabled={!editable}
          readOnly={sentence || go || fixedEndpoints}
          onEdit={sentence || fixedEndpoints ? undefined : url => onEdit({ url })}
        />
        {!recognition && <TextField
          label={t('模型 ID', 'Model ID')}
          name="model"
          value={data.model}
          disabled={!editable}
          readOnly={go}
          onEdit={model => onEdit({ model })}
        />}
        {recognition && data.mode === 'volcengine' && <TextField
          label={t('结果查询地址', 'Results endpoint')}
          name="queryUrl"
          id="asrQueryField"
          type="url"
          value={data.queryUrl}
          readOnly={fixedEndpoints}
          onEdit={fixedEndpoints ? undefined : queryUrl => onEdit({ queryUrl })}
        />}
        {sentence && <label className="field">{t('资源类型', 'Resource type')}
          <select name="resourceId" value={data.resourceId} onChange={event => onEdit({ resourceId: event.target.value })}>
            {sentenceResources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>}
        <KeyFields data={data} saved={editable && provider?.hasKey} optional={!go && !recognition} disabled={!editable} onEdit={onEdit} />
        <output className="service-state">{guidance[name][data.mode]}</output>
      </>}
      {children}
    </fieldset>
  );
}

export function ApiSettingsForm({ onClose, onSettings }) {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(() => makeForm());
  const [message, setMessage] = useState(t('正在读取设置…', 'Loading settings…'));
  const [saving, setSaving] = useState(false);
  const [enteredKey, setEnteredKey] = useState('');
  const [settingsKey, setSettingsKey] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    requestHome('/api/settings', undefined, request.signal).then(config => {
      if (request.signal.aborted) return;
      setSettings(config);
      setDraft(makeForm(config));
      if (config.scope === 'shared') {
        setMessage(t('API 设置保存后全站生效。', 'Saved API settings apply site-wide.'));
      } else {
        setMessage(config.writable === false
          ? t('云端配置由站点的运行时环境变量管理。', 'Cloud settings are managed through the site’s runtime environment variables.') : '');
      }
      onSettings?.(config);
    }).catch(error => {
      if (!request.signal.aborted) setMessage(error.message);
    });
    return () => request.abort();
  }, [onSettings]);

  const shared = settings?.scope === 'shared';
  const writable = shared && !settingsKey ? [] : writableSections(settings);
  const busy = saving || unlocking;
  const locked = !writable.length || busy;

  async function unlock() {
    const key = enteredKey.trim();
    if (!key || busy || !shared || !settings.canUnlock) return;
    setUnlocking(true);
    setMessage(t('正在解锁配置…', 'Unlocking settings…'));
    try {
      const config = await requestSharedSettings(key);
      if (config.scope !== 'shared' || !writableSections(config).length) {
        setMessage(t('无法解锁 API 设置，请检查管理员密钥。', 'Could not unlock API settings. Check the administrator key.'));
        return;
      }
      setSettingsKey(key);
      setEnteredKey('');
      setSettings(config);
      setDraft(makeForm(config));
      setMessage(t('已解锁，保存后全站生效。', 'Unlocked. Saved changes apply site-wide.'));
      onSettings?.(config);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUnlocking(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (locked) return;
    setSaving(true);
    setMessage(t('正在保存配置…', 'Saving settings…'));
    try {
      const payload = Object.fromEntries(writable.map(name => [name, servicePayload(name, draft[name], shared)]));
      const config = shared ? await requestSharedSettings(settingsKey, payload) : await requestHome('/api/settings', payload);
      setSettings(config);
      setDraft(makeForm(config));
      onSettings?.(config);
      setMessage(config.scope === 'shared'
        ? t('API 设置已保存，现已全站生效。', 'API settings are saved and apply site-wide.')
        : t('配置已保存。', 'Settings saved.'));
    } catch (error) {
      if (error.denied) setSettingsKey('');
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  const services = [
    ['agent', 'Agent', t('对话与图片评审', 'Dialogue and image review')],
    ['tts', 'TTS', t('角色配音', 'Character voices')],
    ['asr', 'ASR', t('语音转写', 'Speech transcription')],
  ];
  const edit = (name, change) => setDraft(current => ({ ...current, [name]: { ...current[name], ...change } }));
  const selectMode = (name, mode) => setDraft(current => ({ ...current, [name]: formSection(settings, name, mode) }));
  return (
    <form id="servicesForm" autoComplete="off" onSubmit={save} noValidate>
      {shared && settings.canUnlock && !writable.length && <div className="settings-unlock">
        <TextField
          label={t('管理员密钥', 'Administrator key')}
          name="settingsAdminKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          value={enteredKey}
          onEdit={setEnteredKey}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void unlock();
          }}
        />
        <button className="frame-button" type="button" disabled={busy || !enteredKey.trim()} onClick={unlock}>{t('解锁', 'Unlock')}</button>
      </div>}
      <div className="services-grid">
        {services.map(([name, legend, description]) => <ServiceFieldset
          key={name}
          name={name}
          legend={legend}
          description={description}
          data={draft[name]}
          settings={settings}
          locked={busy || !writable.includes(name)}
          fixedEndpoints={shared && name !== 'agent'}
          onEdit={change => edit(name, change)}
          onMode={mode => selectMode(name, mode)}
        >
          {name === 'agent' && <VisionSettings
            data={draft.vision}
            settings={settings}
            locked={busy || !writable.includes('vision')}
            onEdit={change => edit('vision', change)}
            onMode={mode => selectMode('vision', mode)}
          />}
        </ServiceFieldset>)}
        {settings?.image && <ImageSettings
          data={draft.image}
          provider={settings.image}
          locked={busy || !writable.includes('image')}
          onEdit={change => edit('image', change)}
          onMode={mode => selectMode('image', mode)}
        />}
      </div>
      <p className="form-message" id="servicesMessage" role="status">{message}</p>
      <div className="dialog-actions">
        <button className="frame-button" type="button" onClick={onClose}>{t('关闭', 'Close')}</button>
        <button className="frame-button take-action" type="submit" id="saveServices" disabled={locked}>{t('保存配置', 'Save settings')}</button>
      </div>
    </form>
  );
}
