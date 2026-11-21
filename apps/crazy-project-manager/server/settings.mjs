import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { httpError } from './errors.mjs';
import { roles, fishModels, fishTTS, fishASR, routerTTS, routerModel, routerVoices, defaultCast, volcURL, volcModel, volcCast,
  ttsModes, asrModes, imageModes, volcASR, volcASRQuery, volcFlashASR, volcStreamASRResources, settingsDefaults, settingsStatus } from './runtime-config.mjs';
export { settingsDefaults } from './runtime-config.mjs';

function field(value, label, limit = 256) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw httpError(400, `${label}格式无效。`);
  return value.trim();
}

function endpoint(value, label, { socket = false, optional = false } = {}) {
  const text = field(value, label, 512);
  if (optional && !text) return '';
  let url;
  try { url = new URL(text); } catch { throw httpError(400, `${label}须为完整的接口地址。`); }
  const secure = socket ? 'wss:' : 'https:';
  const local = socket ? 'ws:' : 'http:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== secure && !(url.protocol === local && loopback)) || url.username || url.password || url.hash || url.search) {
    throw httpError(400, `${label}须使用 ${secure.slice(0, -1).toUpperCase()}，本机地址可以用 ${local.slice(0, -1).toUpperCase()}。`);
  }
  return url.href;
}

function setKey(changes, name, input) {
  if (input.clearKey === true) changes[name] = '';
  else if (input.key) changes[name] = field(input.key, 'API 密钥', 2048);
}

function choice(value, choices, label) {
  if (!choices.includes(value)) throw httpError(400, `请选择有效的${label}。`);
  return value;
}

function envSource(filename) {
  try { return readFileSync(filename, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function envValue(value) {
  if (!/[\s#"']/.test(value)) return value;
  const quote = value.includes('"') ? "'" : '"';
  if (value.includes(quote)) throw httpError(400, '配置内容不能同时含两种引号。');
  return `${quote}${value}${quote}`;
}

function saveEnv(filename, changes) {
  let source = envSource(filename);
  for (const [key, value] of Object.entries(changes)) {
    const assignment = `${key}=${envValue(value)}`;
    const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'gm');
    if (line.test(source)) source = source.replace(line, () => assignment);
    else source = `${source.trimEnd()}\n${assignment}\n`;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source.trimStart(), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createSettings(filename, env = process.env) {
  const read = () => settingsDefaults({ ...env, ...parseEnv(envSource(filename).replace(/^\uFEFF/, '')) });

  function update(input) {
    const groups = Object.keys(input);
    if (!groups.length || groups.some(group => !['agent', 'vision', 'tts', 'asr', 'image'].includes(group) || !input[group] || typeof input[group] !== 'object' || Array.isArray(input[group]))) {
      throw httpError(400, '没有可保存的服务设置。');
    }
    const changes = {};
    if (input.agent) {
      const { agent } = input;
      changes.STUDIO_AGENT_MODE = choice(agent.mode, ['local', 'api', 'opencode-go'], 'Agent 模式');
      if (agent.mode === 'opencode-go') setKey(changes, 'OPENCODE_GO_API_KEY', agent);
      else if (agent.mode === 'api') {
        changes.STUDIO_MODEL = field(agent.model ?? '', 'Agent 模型', 160);
        if (!changes.STUDIO_MODEL) throw httpError(400, '请填写 Agent 模型 ID。');
        changes.STUDIO_MODEL_URL = endpoint(agent.url ?? '', 'Agent API');
        setKey(changes, 'STUDIO_MODEL_KEY', agent);
      }
    }
    if (input.vision) {
      const { vision } = input;
      changes.STUDIO_VISION_MODE = choice(vision.mode, ['off', 'inherit', 'api'], '视觉模式');
      if (vision.mode === 'api') {
        changes.STUDIO_VISION_MODEL = field(vision.model ?? '', '视觉模型', 160);
        if (!changes.STUDIO_VISION_MODEL) throw httpError(400, '请填写视觉模型 ID。');
        changes.STUDIO_VISION_URL = endpoint(vision.url ?? '', '视觉 API');
        setKey(changes, 'STUDIO_VISION_KEY', vision);
      }
    }
    if (input.tts) {
      const { tts } = input;
      changes.STUDIO_TTS_MODE = choice(tts.mode, ttsModes, 'TTS 模式');
      if (tts.mode === 'fish') {
        changes.FISH_TTS_URL = endpoint(tts.url || fishTTS, 'TTS API');
        changes.FISH_MODEL = choice(tts.model ?? fishModels[0], fishModels, 'Fish 模型');
        setKey(changes, 'FISH_TTS_API_KEY', tts);
        for (const role of roles) changes[`FISH_VOICE_${role.toUpperCase()}`] = field(tts.voices?.[role] ?? '', '音色 ID');
      } else if (tts.mode === 'openrouter') {
        changes.OPENROUTER_TTS_URL = endpoint(tts.url || routerTTS, 'OpenRouter TTS API');
        changes.OPENROUTER_TTS_MODEL = routerModel;
        setKey(changes, 'OPENROUTER_API_KEY', tts);
        for (const role of roles) changes[`OPENROUTER_VOICE_${role.toUpperCase()}`] = choice(tts.voices?.[role] ?? defaultCast[role], routerVoices, 'HeyGen 音色');
      } else if (tts.mode === 'volcengine') {
        changes.VOLCENGINE_TTS_URL = endpoint(tts.url || volcURL, '火山引擎 TTS API');
        changes.VOLCENGINE_TTS_RESOURCE_ID = volcModel;
        setKey(changes, 'VOLCENGINE_API_KEY', tts);
        for (const role of roles) changes[`VOLCENGINE_VOICE_${role.toUpperCase()}`] = field(tts.voices?.[role] ?? volcCast[role], '豆包 2.0 音色 ID');
      }
    }
    if (input.asr) {
      const { asr } = input;
      changes.STUDIO_ASR_MODE = choice(asr.mode, asrModes, 'ASR 模式');
      if (asr.mode === 'fish') {
        changes.FISH_ASR_URL = endpoint(asr.url || fishASR, 'ASR API', { socket: true });
        setKey(changes, 'FISH_ASR_API_KEY', asr);
      } else if (asr.mode === 'volcengine') {
        changes.VOLCENGINE_ASR_URL = endpoint(asr.url || volcASR, '火山 ASR 提交接口');
        changes.VOLCENGINE_ASR_QUERY_URL = endpoint(asr.queryUrl || volcASRQuery, '火山 ASR 查询接口');
        setKey(changes, 'VOLCENGINE_ASR_API_KEY', asr);
      } else if (asr.mode === 'volcengine-flash') {
        changes.VOLCENGINE_FLASH_ASR_URL = endpoint(asr.url || volcFlashASR, '火山极速版 ASR');
        setKey(changes, 'VOLCENGINE_FLASH_ASR_KEY', asr);
      } else if (asr.mode === 'volcengine-sentence') {
        if (Object.hasOwn(asr, 'resourceId')) {
          changes.VOLCENGINE_SENTENCE_ASR_RESOURCE_ID = choice(asr.resourceId, volcStreamASRResources, '豆包语音识别资源');
        }
        setKey(changes, 'VOLCENGINE_SENTENCE_ASR_API_KEY', asr);
      }
    }
    if (input.image) {
      changes.STUDIO_IMAGE_MODE = choice(input.image.mode, imageModes, '图片生成模式');
      setKey(changes, 'AMD_CREATIVE_HUB_API_KEY', input.image);
    }
    saveEnv(filename, changes);
    return settingsStatus(read());
  }

  return { read, update, status: () => settingsStatus(read()) };
}
