import { language, t } from './i18n.js';

const settingLabels = {
  'API 密钥': 'API key',
  'Agent 模式': 'Agent mode',
  'Agent 模型': 'Agent model',
  'Agent API': 'Agent endpoint',
  '视觉模式': 'vision mode',
  '视觉模型': 'vision model',
  '视觉 API': 'vision endpoint',
  'TTS 模式': 'TTS mode',
  'TTS API': 'TTS endpoint',
  'Fish 模型': 'Fish model',
  '音色 ID': 'voice ID',
  'OpenRouter TTS API': 'OpenRouter TTS endpoint',
  'HeyGen 音色': 'HeyGen voice',
  '火山引擎 TTS API': 'Volcengine TTS endpoint',
  '豆包 2.0 音色 ID': 'Doubao 2.0 voice ID',
  'ASR 模式': 'ASR mode',
  'ASR API': 'ASR endpoint',
  '火山 ASR 提交接口': 'Volcengine ASR submission endpoint',
  '火山 ASR 查询接口': 'Volcengine ASR results endpoint',
  '火山极速版 ASR': 'Volcengine Flash ASR endpoint',
};
const errorMessages = {
  '没有可保存的服务设置。': 'There are no service settings to save.',
  '配置内容不能同时含两种引号。': 'A setting value cannot contain both single and double quotes.',
  '请填写 Agent 模型 ID。': 'Enter an Agent model ID.',
  '请填写视觉模型 ID。': 'Enter a vision model ID.',
  '这个工作台接口不存在。': 'This workspace endpoint is unavailable.',
  '请从工作台页面提交操作。': 'Submit this request from the workspace page.',
  '请从本机工作台打开 API 设置。': 'Open API settings from the local workspace.',
  '这次提交的数据超出大小限制。': 'This submission is too large.',
  '提交内容不是有效的 JSON。': 'The submission is not valid JSON.',
};

function errorCopy(message, url, submitted) {
  const fallback = url === '/api/settings'
    ? (submitted ? t('无法保存设置。', 'Could not save settings.') : t('无法读取设置。', 'Could not load settings.'))
    : (submitted ? t('无法创建项目。', 'Could not create the project.') : t('无法读取项目历史。', 'Could not load project history.'));
  if (typeof message !== 'string' || !message) return fallback;
  if (language !== 'en' || !/\p{Script=Han}/u.test(message)) return message;
  if (Object.hasOwn(errorMessages, message)) return errorMessages[message];
  if (/云端.*环境变量/.test(message)) return 'Cloud settings are managed through the site’s runtime environment variables.';
  if (/项目主题|项目名/.test(message)) return 'Enter a project theme of up to 26 characters.';
  let matched = message.match(/^请选择有效的(.+)。$/);
  if (matched && settingLabels[matched[1]]) return `Choose a valid ${settingLabels[matched[1]]}.`;
  matched = message.match(/^(.+)格式无效。$/);
  if (matched && settingLabels[matched[1]]) return `Check the ${settingLabels[matched[1]]} format.`;
  matched = message.match(/^(.+)须为完整的接口地址。$/);
  if (matched && settingLabels[matched[1]]) return `Enter the full URL for the ${settingLabels[matched[1]]}.`;
  matched = message.match(/^(.+)须使用 (HTTPS|WSS)，本机地址可以用 (HTTP|WS)。$/);
  if (matched && settingLabels[matched[1]]) {
    return `Use ${matched[2]} for the ${settingLabels[matched[1]]}. Localhost can use ${matched[3]}.`;
  }
  return fallback;
}

export async function requestHome(url, data, abortSignal) {
  const timeout = AbortSignal.timeout(8000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, data === undefined ? { signal } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
  } catch {
    throw new Error(timeout.aborted
      ? t('这次请求已超时，请重试。', 'The request timed out. Try again.')
      : t('无法连接工作台。', 'Could not reach the workspace.'));
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(errorCopy(result?.error, url, data !== undefined));
  return result;
}

export function workbenchUrl(id, opening = false) {
  const url = new URL('/workbench', location.origin);
  url.searchParams.set('project', id);
  if (opening) url.searchParams.set('intro', '1');
  url.searchParams.set('lang', language);
  return url.href;
}
