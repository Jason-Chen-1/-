import { createHash, timingSafeEqual } from 'node:crypto';
import { httpError } from '../server/errors.mjs';
import { asrModes, fishModels, imageModes, roles, routerVoices, settingsStatus, ttsModes, volcStreamASRResources } from '../server/runtime-config.mjs';
import { decodeBase64, encodeBase64 } from '../server/voice-bytes.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const modes = { agent: ['local', 'opencode-go', 'api'], tts: ttsModes, asr: asrModes, image: imageModes };
const services = Object.keys(modes);
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function keyBytes(env) {
  const value = env.STUDIO_SETTINGS_SECRET;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

function importKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function matchesAdminKey(supplied, expected) {
  if (!supplied || supplied.length > 2048) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

function encryptionParameters(iv, revision) {
  return {
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode('studio_voice_settings:shared:v1:' + revision),
  };
}

async function readStored(env, key) {
  if (!key) return null;
  const row = await env.DB.prepare("SELECT revision, iv, ciphertext FROM studio_voice_settings WHERE id='shared'").first();
  if (!row) return null;
  try {
    const data = await crypto.subtle.decrypt(
      encryptionParameters(decodeBase64(row.iv), row.revision), key, decodeBase64(row.ciphertext),
    );
    const overrides = JSON.parse(decoder.decode(data));
    if (!record(overrides)) throw new Error();
    return { revision: row.revision, overrides };
  } catch {
    throw httpError(503, '暂时无法读取共享 API 设置。');
  }
}

function endpointOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function effectiveCustomAgent(defaults, saved) {
  const url = typeof saved.url === 'string' ? saved.url : defaults.url;
  const model = typeof saved.model === 'string' ? saved.model : defaults.model;
  const origin = endpointOrigin(url);
  const defaultKey = origin === endpointOrigin(defaults.url) ? defaults.key : '';
  const key = saved.key === '' || (typeof saved.key === 'string' && saved.keyOrigin === origin) ? saved.key : defaultKey;
  return { ...defaults, url, model, key };
}

function effectiveService(name, defaults, saved) {
  if (!saved) return defaults;
  const mode = modes[name].includes(saved.mode) ? saved.mode : defaults.mode;
  if (name === 'image') return { ...defaults, mode, key: typeof saved.key === 'string' ? saved.key : defaults.key };
  const providers = Object.fromEntries(Object.entries(defaults.providers).map(([id, provider]) => {
    const override = saved.providers?.[id];
    if (!override) return [id, provider];
    if (name === 'agent' && id === 'api') return [id, effectiveCustomAgent(provider, override)];
    const selected = { ...provider };
    if (typeof override.key === 'string') selected.key = override.key;
    if (name === 'asr' && id === 'volcengine-sentence' && volcStreamASRResources.includes(override.resourceId)) {
      selected.resourceId = override.resourceId;
    }
    if (name === 'tts') {
      if (id === 'fish' && fishModels.includes(override.model)) selected.model = override.model;
      selected.voices = { ...provider.voices };
      for (const role of roles) {
        if (typeof override.voices?.[role] === 'string') selected.voices[role] = override.voices[role];
      }
    }
    return [id, selected];
  }));
  const sentence = providers['volcengine-sentence'];
  if (name === 'asr' && sentence?.inheritKeyFrom === 'volcengine' && typeof saved.providers?.['volcengine-sentence']?.key !== 'string') {
    providers['volcengine-sentence'] = { ...sentence, key: providers.volcengine.key };
  }
  return { mode, ...(providers[mode] ?? (name === 'agent' ? providers.api : providers.fish)), providers };
}

function effectiveConfig(defaults, saved) {
  if (!saved) return defaults;
  const agent = effectiveService('agent', defaults.agent, saved.agent);
  const vision = defaults.vision.mode === 'inherit'
    ? { ...defaults.vision, url: agent.url, model: agent.model, key: agent.key }
    : defaults.vision;
  return {
    ...defaults,
    agent,
    vision,
    tts: effectiveService('tts', defaults.tts, saved.tts),
    asr: effectiveService('asr', defaults.asr, saved.asr),
    image: effectiveService('image', defaults.image, saved.image),
  };
}

function field(value, label, limit = 256) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw httpError(400, label + '格式无效。');
  }
  return value.trim();
}

function choice(value, allowed, label) {
  if (!allowed.includes(value)) throw httpError(400, '请选择有效的' + label + '。');
  return value;
}

function isPublicHost(hostname) {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[')) {
    const [first, second] = host.slice(1, -1).split(':');
    return /^[23][0-9a-f]{3}$/.test(first) && first !== '2002' && first !== '3fff' &&
      (first !== '2001' || (second !== 'db8' && Number.parseInt(second || '0', 16) > 0x1ff));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [first, second, third] = host.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)) || (second === 88 && third === 99))) ||
      (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
      (first === 203 && second === 0 && third === 113));
  }
  return host.includes('.') &&
    !/(?:^|\.)(?:localhost|local|localdomain|internal|lan|home\.arpa|test|invalid|example|onion)$/.test(host) &&
    host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
}

function publicAgentEndpoint(value) {
  const text = field(value, 'Agent 服务地址', 512);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError(400, '请填写完整的 Agent HTTPS 服务地址。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !isPublicHost(url.hostname)) {
    throw httpError(400, 'Agent 服务需要可公开访问的 HTTPS 地址，地址请勿包含凭证、查询参数或片段。');
  }
  return url;
}

function submittedKey(input) {
  if (input.clearKey === true) return '';
  if (Object.hasOwn(input, 'key')) return field(input.key, 'API 密钥', 2048) || undefined;
  return undefined;
}

function updateCustomAgent(provider, changes, input, key) {
  const endpoint = publicAgentEndpoint(Object.hasOwn(input, 'url') ? input.url : provider.url);
  const model = field(Object.hasOwn(input, 'model') ? input.model : provider.model, 'Agent 模型', 160);
  if (!model) throw httpError(400, '请填写 Agent 模型 ID。');
  if (endpoint.href !== provider.url) changes.url = endpoint.href;
  if (model !== provider.model) changes.model = model;
  const changedOrigin = endpoint.origin !== endpointOrigin(provider.url);
  if (key === '' || (changedOrigin && key === undefined)) {
    changes.key = '';
    delete changes.keyOrigin;
  } else if (key !== undefined && (changedOrigin || key !== provider.key)) {
    changes.key = key;
    changes.keyOrigin = endpoint.origin;
  }
}

function updatedService(name, defaults, saved, input) {
  const current = effectiveService(name, defaults, saved);
  const mode = Object.hasOwn(input, 'mode') ? choice(input.mode, modes[name], name.toUpperCase() + ' 模式') : current.mode;
  const next = { ...saved };
  if (mode !== current.mode) next.mode = mode;
  if (name === 'image') {
    const key = submittedKey(input);
    if (key === '' || (key !== undefined && key !== current.key)) next.key = key;
    return next;
  }
  if (!Object.hasOwn(current.providers, mode)) return next;

  const provider = current.providers[mode];
  const changes = { ...saved?.providers?.[mode] };
  const key = submittedKey(input);
  if (name === 'agent' && mode === 'api') updateCustomAgent(provider, changes, input, key);
  else if (key === '' || (key !== undefined && key !== provider.key)) changes.key = key;
  if (name === 'asr' && mode === 'volcengine-sentence' && Object.hasOwn(input, 'resourceId')) {
    const resourceId = choice(input.resourceId, volcStreamASRResources, '豆包语音识别资源');
    if (resourceId !== provider.resourceId) changes.resourceId = resourceId;
  }
  if (name === 'tts' && mode === 'fish' && Object.hasOwn(input, 'model')) {
    const model = choice(input.model, fishModels, 'Fish 模型');
    if (model !== provider.model) changes.model = model;
  }
  if (name === 'tts' && Object.hasOwn(input, 'voices')) {
    if (!record(input.voices)) throw httpError(400, '角色音色格式无效。');
    const voices = { ...changes.voices };
    for (const role of roles) {
      if (!Object.hasOwn(input.voices, role)) continue;
      const voice = field(input.voices[role], '音色 ID');
      if (voice === provider.voices[role]) continue;
      voices[role] = mode === 'openrouter' ? choice(voice, routerVoices, 'HeyGen 音色') : voice;
    }
    if (Object.keys(voices).length) changes.voices = voices;
  }
  if (Object.keys(changes).length) next.providers = { ...saved?.providers, [mode]: changes };
  return next;
}

async function saveStored(env, key, defaults, input) {
  const submitted = services.filter(service => Object.hasOwn(input, service));
  if (!submitted.length || submitted.some(service => !record(input[service]))) {
    throw httpError(400, '没有可保存的共享 API 设置。');
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await readStored(env, key);
    const overrides = { ...previous?.overrides };
    for (const service of submitted) {
      const next = updatedService(service, defaults[service], overrides[service], input[service]);
      if (Object.keys(next).length) overrides[service] = next;
    }
    if (JSON.stringify(overrides) === JSON.stringify(previous?.overrides ?? {})) return previous;

    const revision = crypto.randomUUID();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      encryptionParameters(iv, revision), key, encoder.encode(JSON.stringify(overrides)),
    );
    const values = [revision, encodeBase64(iv), encodeBase64(new Uint8Array(encrypted)), Date.now()];
    const statement = previous
      ? env.DB.prepare("UPDATE studio_voice_settings SET revision=?, iv=?, ciphertext=?, updated_at=? WHERE id='shared' AND revision=?")
        .bind(...values, previous.revision)
      : env.DB.prepare("INSERT INTO studio_voice_settings (id, revision, iv, ciphertext, updated_at) VALUES ('shared', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .bind(...values);
    const result = await statement.run();
    if (result.meta.changes === 1) return { revision, overrides };
  }
  throw httpError(409, '共享 API 设置刚有更新，请重试。');
}

export async function readSharedSettings(env, defaults) {
  const bytes = keyBytes(env);
  if (!bytes) return defaults;
  const saved = await readStored(env, await importKey(bytes));
  if (!saved) return defaults;
  return effectiveConfig(defaults, saved.overrides);
}

export async function sharedSettingsStatus(request, env, defaults, readBody) {
  const bytes = keyBytes(env);
  const expected = env.STUDIO_SETTINGS_ADMIN_KEY;
  const supplied = request.headers.get('X-Studio-Settings-Key');
  const canUnlock = Boolean(bytes && typeof expected === 'string' && expected);
  const writable = canUnlock && matchesAdminKey(supplied, expected);
  const saving = request.method === 'POST';
  if ((saving || supplied !== null) && !writable) {
    throw httpError(403, canUnlock ? '管理密钥无效。' : '共享 API 设置当前为只读。');
  }
  const key = bytes ? await importKey(bytes) : null;
  const saved = saving ? await saveStored(env, key, defaults, await readBody()) : await readStored(env, key);
  return {
    ...settingsStatus(effectiveConfig(defaults, saved?.overrides), { writable }),
    scope: 'shared',
    canUnlock,
    writableServices: writable ? services : [],
  };
}

export { readSharedSettings as readSharedVoiceSettings, sharedSettingsStatus as sharedVoiceSettingsStatus };
