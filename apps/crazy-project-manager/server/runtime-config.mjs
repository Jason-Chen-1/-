export const roles = ['zhou', 'lin', 'tang', 'yi'];
export const fishModels = ['s2.1-pro', 's2-pro', 's2.1-pro-free'];
export const fishTTS = 'https://api.fish.audio/v1/tts';
export const fishASR = 'wss://api.fish.audio/v1/asr/realtime';
export const routerTTS = 'https://openrouter.ai/api/v1/audio/speech';
export const routerModel = 'heygen/heygen-voice-1-turbo:free';
export const routerVoices = ['nadine', 'tabitha', 'bram', 'gareth', 'noelle', 'meredith', 'sabrina', 'lucian', 'weston', 'vincent'];
export const defaultCast = { zhou: 'gareth', lin: 'sabrina', tang: 'lucian', yi: 'bram' };
export const volcURL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const volcModel = 'seed-tts-2.0';
export const volcCast = {
  zhou: 'zh_male_m191_uranus_bigtts', lin: 'zh_female_xiaohe_uranus_bigtts',
  tang: 'zh_male_yangguangqingnian_uranus_bigtts', yi: 'zh_male_taocheng_uranus_bigtts'
};
export const ttsModes = ['local', 'fish', 'openrouter', 'volcengine'];
export const asrModes = ['browser', 'fish', 'volcengine', 'volcengine-flash', 'volcengine-sentence'];
export const imageModes = ['off', 'amd'];
export const amdImageModel = 'Qwen-Image-2.1-Turbo';
export const amdImageRatios = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16']);
export const volcASR = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
export const volcASRQuery = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';
export const volcFlashASR = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
export const volcSentenceASR = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
export const volcStreamASRResources = ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent'];
export const goDefaults = { url: 'https://opencode.ai/inference/go/openai/v1/chat/completions', model: 'hy4-flash-free' };

const voicesFrom = (env, prefix, fallback = {}) => Object.fromEntries(roles.map(role => [role, env[`${prefix}_${role.toUpperCase()}`] ?? fallback[role] ?? '']));

export function settingsDefaults(env = globalThis.process?.env ?? {}) {
  const fish = {
    url: env.FISH_TTS_URL || fishTTS, model: fishModels.includes(env.FISH_MODEL) ? env.FISH_MODEL : fishModels[0],
    key: env.FISH_TTS_API_KEY ?? env.FISH_API_KEY ?? '', voices: voicesFrom(env, 'FISH_VOICE')
  };
  const openrouter = {
    url: env.OPENROUTER_TTS_URL || routerTTS, model: routerModel,
    key: env.OPENROUTER_API_KEY ?? '', voices: voicesFrom(env, 'OPENROUTER_VOICE', defaultCast)
  };
  const volcengine = {
    url: env.VOLCENGINE_TTS_URL || volcURL, model: volcModel,
    key: env.VOLCENGINE_API_KEY ?? '', voices: voicesFrom(env, 'VOLCENGINE_VOICE', volcCast)
  };
  const providers = { fish, openrouter, volcengine };
  const ttsMode = ttsModes.includes(env.STUDIO_TTS_MODE) ? env.STUDIO_TTS_MODE
    : openrouter.key ? 'openrouter' : volcengine.key ? 'volcengine' : fish.key ? 'fish' : 'local';
  const sentenceResource = env.VOLCENGINE_SENTENCE_ASR_RESOURCE_ID ?? env.VOLCENGINE_STREAM_ASR_RESOURCE_ID;
  const asrProviders = {
    fish: { url: env.FISH_ASR_URL || fishASR, key: env.FISH_ASR_API_KEY ?? env.FISH_API_KEY ?? '' },
    volcengine: { url: env.VOLCENGINE_ASR_URL || volcASR, queryUrl: env.VOLCENGINE_ASR_QUERY_URL || volcASRQuery,
      key: env.VOLCENGINE_ASR_API_KEY ?? '', resourceId: 'volc.seedasr.auc' },
    'volcengine-flash': { url: env.VOLCENGINE_FLASH_ASR_URL || volcFlashASR,
      key: env.VOLCENGINE_FLASH_ASR_KEY ?? env.VOLCENGINE_ASR_API_KEY ?? '', resourceId: 'volc.bigasr.auc_turbo' },
    'volcengine-sentence': { url: volcSentenceASR,
      key: env.VOLCENGINE_SENTENCE_ASR_API_KEY ?? env.VOLCENGINE_ASR_API_KEY ?? '',
      inheritKeyFrom: env.VOLCENGINE_SENTENCE_ASR_API_KEY === undefined ? 'volcengine' : undefined,
      resourceId: volcStreamASRResources.includes(sentenceResource) ? sentenceResource : volcStreamASRResources[0] },
  };
  const asrMode = asrModes.includes(env.STUDIO_ASR_MODE) ? env.STUDIO_ASR_MODE : asrProviders.fish.key ? 'fish' : 'browser';
  const agentMode = ['local', 'api', 'opencode-go'].includes(env.STUDIO_AGENT_MODE) ? env.STUDIO_AGENT_MODE
    : env.OPENCODE_GO_API_KEY ? 'opencode-go' : env.STUDIO_MODEL_URL && env.STUDIO_MODEL ? 'api' : 'local';
  const go = { ...goDefaults, key: env.OPENCODE_GO_API_KEY ?? '' };
  const custom = { url: env.STUDIO_MODEL_URL ?? '', model: env.STUDIO_MODEL ?? '', key: env.STUDIO_MODEL_KEY ?? '' };
  const useGo = agentMode === 'opencode-go';
  const agent = { mode: agentMode, ...(useGo ? go : custom), providers: { 'opencode-go': go, api: custom } };
  const visionMode = ['off', 'inherit', 'api'].includes(env.STUDIO_VISION_MODE) ? env.STUDIO_VISION_MODE : 'inherit';
  const visual = { url: env.STUDIO_VISION_URL ?? '', model: env.STUDIO_VISION_MODEL ?? '', key: env.STUDIO_VISION_KEY ?? '' };
  const imageMode = imageModes.includes(env.STUDIO_IMAGE_MODE) ? env.STUDIO_IMAGE_MODE : 'off';
  const imageKey = env.AMD_CREATIVE_HUB_API_KEY;
  return {
    agent,
    vision: { mode: visionMode, ...(visionMode === 'inherit' ? (useGo ? go : custom) : visual), custom: visual },
    tts: { mode: ttsMode, ...(providers[ttsMode] ?? fish), providers },
    asr: { mode: asrMode, ...(asrProviders[asrMode] ?? asrProviders.fish), providers: asrProviders },
    image: { mode: imageMode, key: typeof imageKey === 'string' ? imageKey.trim() : '', model: amdImageModel },
  };
}

export function activeAgent(config) {
  const text = config.agent.mode === 'local' || (config.agent.mode === 'opencode-go' && !config.agent.key)
    ? { mode: 'local' } : { ...config.agent, mode: 'api' };
  const vision = config.vision.mode === 'api' ? config.vision : text;
  return { text, vision };
}

function safe({ key, inheritKeyFrom, ...display }) {
  return { ...display, hasKey: Boolean(key) };
}

export function settingsStatus(config, { writable = true } = {}) {
  const { text, vision } = activeAgent(config);
  const ready = service => service.mode !== 'local' && service.mode !== 'off' && Boolean(service.url && service.model);
  const { providers: agentProviders, ...selectedAgent } = config.agent;
  const { providers: ttsProviders, ...selectedTTS } = config.tts;
  const { providers: asrProviders, ...selectedASR } = config.asr;
  const { custom: visionCustom, ...selectedVision } = config.vision;
  const activeVoices = config.tts.mode === 'local' || !config.tts.key ? [] : roles.filter(role => config.tts.voices[role]);
  const redact = providers => Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, safe(provider)]));
  return {
    writable,
    agent: { ...safe(selectedAgent), providers: redact(agentProviders), available: ready(text) },
    vision: { ...safe(selectedVision), custom: safe(visionCustom), available: ready(vision) },
    tts: { ...safe(selectedTTS), providers: redact(ttsProviders), voiceIds: routerVoices, available: activeVoices.length > 0, activeVoices },
    asr: { ...safe(selectedASR), providers: redact(asrProviders), available: config.asr.mode !== 'browser' && Boolean(config.asr.key) },
    image: { ...safe(config.image), modelLabel: 'Qwen-Image 2.1 Turbo', aspectRatios: amdImageRatios,
      available: config.image.mode === 'amd' && Boolean(config.image.key) },
  };
}
