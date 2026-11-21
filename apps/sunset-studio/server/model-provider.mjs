import {normalizeApiKey} from './credentials.mjs';
import {fetchWithoutRedirect} from './upstream.mjs';

export const modelDefaults = {
  baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', speechMode: 'fish',
  ttsModel: 'gpt-4o-mini-tts', jsonMode: true, apiStyle: 'chat', verified: false,
};

export function normalizeBase(raw, allowLocal = true) {
  let url;
  try { url = new URL(String(raw)); }
  catch { throw new Error('Enter a valid API base URL.'); }
  if (url.username || url.password || url.search || url.hash || url.href.length > 600) {
    throw new Error('API base URL cannot contain credentials, query parameters, or fragments.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocal && loopback && url.protocol === 'http:')) {
    throw new Error('Use an HTTPS API base URL.');
  }
  if (!allowLocal && (loopback || !url.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))) {
    throw new Error('Use the public domain of your model provider.');
  }
  return url.href.replace(/\/(chat\/completions|responses|audio\/speech)\/?$/, '').replace(/\/$/, '');
}

export function updatedModel(data, previous, allowLocal) {
  const baseUrl = normalizeBase(data.baseUrl || previous.baseUrl, allowLocal);
  const model = String(data.model || '').trim().slice(0, 180);
  const nextKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  if (!nextKey && previous.apiKey && new URL(baseUrl).origin !== new URL(previous.baseUrl).origin) {
    throw new Error('Changing provider requires entering its API key.');
  }
  const apiKey = normalizeApiKey(nextKey || previous.apiKey);
  if (!model) throw new Error('Enter the model name.');
  return {
    baseUrl, model, apiKey, verified: false,
    speechMode: ['fish', 'browser', 'api'].includes(data.speechMode) ? data.speechMode : 'fish',
    ttsModel: String(data.ttsModel || modelDefaults.ttsModel).slice(0, 100),
    jsonMode: data.jsonMode !== false, apiStyle: data.apiStyle === 'responses' ? 'responses' : 'chat',
  };
}

export function modelStatus(config, admin = false) {
  const {baseUrl, model, verified, speechMode, ttsModel, jsonMode, apiStyle} = config;
  return {
    configured: Boolean(config.apiKey && model), verified: verified === true, speechMode,
    expertSkills: true, webSearch: true,
    ...(admin ? {baseUrl, model, ttsModel, jsonMode, apiStyle} : {}),
  };
}

export function createModelClient(fetchImpl) {
  async function upstream(config, route, payload, signal) {
    const apiKey = normalizeApiKey(config.apiKey);
    const timeout = AbortSignal.timeout(110000);
    const response = await fetchWithoutRedirect(fetchImpl, config.baseUrl + route, {
      method: 'POST', headers: {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) return response;
    let message = '';
    try {
      const error = await response.json();
      message = error.error?.message || error.message || '';
    } catch {}
    throw new Error(`API ${response.status}: ${message || response.statusText}`);
  }

  async function complete(config, messages, signal) {
    if (config.apiStyle === 'responses') {
      const input = messages.map(message => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.map(part => part.type === 'image_url'
          ? {type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail}
          : {type: 'input_text', text: part.text}) : message.content,
      }));
      const payload = {model: config.model, input, max_output_tokens: 6000};
      if (/^gpt-5\.4/.test(config.model)) payload.reasoning = {effort: 'none'};
      if (config.jsonMode) payload.text = {format: {type: 'json_object'}};
      const result = await (await upstream(config, '/responses', payload, signal)).json();
      if (result.status === 'incomplete') throw new Error('Model output was truncated. Use a model with enough output capacity.');
      return result.output_text || result.output?.filter(item => item.type === 'message')
        .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('') || '';
    }

    const payload = {model: config.model, messages, stream: false};
    if (/^(gpt-[56]|o[134])/.test(config.model)) payload.max_completion_tokens = 6000;
    else payload.max_tokens = 4500;
    if (/^gpt-5\.4/.test(config.model)) payload.reasoning_effort = 'none';
    if (config.jsonMode) payload.response_format = {type: 'json_object'};
    const result = await (await upstream(config, '/chat/completions', payload, signal)).json();
    const choice = result.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Model output was truncated.');
    if (choice?.message?.refusal) throw new Error(choice.message.refusal);
    const content = choice?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part.text || '').join('');
    throw new Error('No usable content in the model response.');
  }

  return {upstream, complete};
}
