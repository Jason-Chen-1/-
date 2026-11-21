import { toolResult } from './tool-trace.mjs';

const reasoningOff = new Set([
  'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5', 'gpt-5.6-luna',
  'gpt-6-luna', 'gpt-6.1-terra',
]);
const reasoningLow = new Set([
  'o1', 'o3', 'o3-mini', 'o4-mini', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol',
]);

function minimumOpenAIEffort(id) {
  const model = id.replace(/-\d{4}-\d\d-\d\d$/, '');
  if (reasoningOff.has(model)) return 'none';
  if (/^gpt-5(?:-mini|-nano)?$/.test(model)) return 'minimal';
  if (reasoningLow.has(model)) return 'low';
  return undefined;
}

function reasoningProfile(endpoint, model, openCodeGo) {
  if (openCodeGo && model === 'hy4-flash-free') {
    return { parameter: 'reasoning_effort', levels: ['none'] };
  }
  if (endpoint.origin === 'https://api.openai.com') {
    const effort = minimumOpenAIEffort(model);
    if (effort) return { parameter: 'reasoning_effort', levels: [effort], openAI: true };
  }
  if (endpoint.origin === 'https://openrouter.ai') {
    if (/^openrouter\/(?:auto|free)$/.test(model) || /^openai\/gpt-4/.test(model)) return null;
    const openAIModel = /^openai\/([^:]+)(?::|$)/.exec(model)?.[1];
    const effort = openAIModel ? minimumOpenAIEffort(openAIModel) : undefined;
    return { parameter: 'reasoning', levels: effort ? [effort] : ['none', 'minimal', 'low'], openAI: Boolean(effort) };
  }
  return null;
}

export function configureChatProvider(input, field, defaultTimeout) {
  if (!input?.url || !input?.model || (input.mode && input.mode !== 'api')) return null;
  const endpoint = new URL(input.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (!(endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:')) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`${field} 必须是 HTTPS 或本机 HTTP 地址`);
  }
  const openCodeGo = endpoint.origin === 'https://opencode.ai' && endpoint.pathname.startsWith('/inference/go/');
  const timeout = Number.isFinite(input.timeoutMs) ? Math.max(25, Math.min(15000, Math.round(input.timeoutMs)))
    : openCodeGo ? defaultTimeout + 4500 : defaultTimeout;
  const headers = { 'Content-Type': 'application/json' };
  if (input.key) headers.Authorization = `Bearer ${input.key}`;
  if (openCodeGo) headers['User-Agent'] = 'yifang-studio/1.0';
  const reasoning = reasoningProfile(endpoint, input.model, openCodeGo);
  return { endpoint, headers, model: input.model, timeout, openCodeGo, reasoning };
}

function completionPayload(upstream, body, options) {
  const payload = { model: upstream.model, ...body };
  const profile = upstream.reasoning;
  const effort = profile?.levels[options.level];
  if (effort !== undefined) {
    payload[profile.parameter] = profile.parameter === 'reasoning' ? { effort, exclude: true } : effort;
  }
  if (profile?.openAI && effort !== 'none') {
    delete payload.temperature;
    delete payload.top_p;
    delete payload.logprobs;
    delete payload.top_logprobs;
  }
  if (options.json) payload.response_format ??= { type: 'json_object' };
  return payload;
}

async function rejectionDetails(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value?.subarray(0, 8192)).toLowerCase();
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function fallbackOptions(upstream, options, detail) {
  const levels = upstream.reasoning?.levels.length ?? 0;
  const hasReasoning = options.level < levels;
  const rejectsJSON = options.json && /response[_\s-]*format|json[_\s-]*object/.test(detail);
  const rejectsReasoning = hasReasoning && /reasoning|thinking/.test(detail);
  if (rejectsJSON || rejectsReasoning) {
    const triesAnotherEffort = upstream.reasoning?.parameter === 'reasoning' &&
      /effort|mandatory|required|disable/.test(detail) && !/unknown|unrecognized|unexpected/.test(detail);
    return {
      json: options.json && !rejectsJSON,
      level: rejectsReasoning ? (triesAnotherEffort ? options.level + 1 : levels) : options.level,
    };
  }
  if (/\b(?:tools?|tool_choice|messages?|image_url|max_tokens|max_completion_tokens|temperature)\b/.test(detail)) return null;
  return { json: false, level: levels };
}

const streamFrameLimit = 128 * 1024;
export const chatStreamTimeout = 30_000;

async function* eventData(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer) buffer += '\n';
      let boundary;
      while ((boundary = /\r\n|\n|\r(?!$)/.exec(buffer))) {
        const line = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          size = 0;
        } else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /, '');
          size += part.length + 1;
          if (size > streamFrameLimit) throw new Error('Agent 的流式事件过大。');
          data.push(part);
        }
      }
      if (buffer.length + size > streamFrameLimit) throw new Error('Agent 的流式事件过大。');
      if (done) {
        if (data.length) yield data.join('\n');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function deltaText(delta) {
  if (typeof delta?.content === 'string') return delta.content;
  if (!Array.isArray(delta?.content)) return '';
  return delta.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

async function readTextStream(response, signal, onDelta) {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime !== 'text/event-stream' || !response.body) {
    await response.body?.cancel();
    throw new Error('当前 Agent 接口不支持 Chat Completions 的 SSE 文本流。');
  }
  let id;
  let content = '';
  let finish;
  let terminated = false;
  for await (const event of eventData(response.body, signal)) {
    signal.throwIfAborted();
    if (event.trim() === '[DONE]') {
      terminated = true;
      break;
    }
    let frame;
    try {
      frame = JSON.parse(event);
    } catch {
      throw new Error('Agent 返回了无法读取的 SSE 文本事件。');
    }
    if (frame?.error) throw new Error('Agent 在继续发言前结束了文本流。');
    id ??= frame?.id;
    const choice = Array.isArray(frame?.choices) ? frame.choices.find(item => (item?.index ?? 0) === 0) : null;
    if (!choice) continue;
    finish = choice.finish_reason ?? finish;
    if (choice.delta?.refusal || choice.delta?.tool_calls?.length || choice.delta?.function_call) {
      throw new Error('Agent 未返回本轮可朗读的文本。');
    }
    const delta = deltaText(choice.delta);
    if (!delta) continue;
    content += delta;
    await onDelta?.(delta);
  }
  signal.throwIfAborted();
  if ((!terminated && !finish) || ['length', 'content_filter', 'tool_calls', 'function_call'].includes(finish)) {
    throw new Error('Agent 的文本流在完成前中断。');
  }
  if (!content.trim()) throw new Error('Agent 未返回本轮发言。');
  return { id, choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] };
}

export function streamChatCompletion(upstream, body, options) {
  return chatCompletion(upstream, { ...body, stream: true }, options);
}

export async function chatCompletion(upstream, body, { sessionId, roundId, role, signal, onTrace, imageHash, jsonMode = false, onDelta, returnCompletion = false } = {}) {
  const streaming = body.stream === true;
  const headers = {
    ...upstream.headers,
    ...(upstream.openCodeGo ? { 'X-OpenCode-Session': `ses_${sessionId ?? crypto.randomUUID()}_${roundId ?? role}` } : {}),
    ...(streaming ? { Accept: 'text/event-stream' } : {}),
  };
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(streaming ? Math.max(chatStreamTimeout, upstream.timeout) : upstream.timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let options = { json: !streaming && jsonMode && !upstream.openCodeGo, level: 0 };
  let retries = 0;
  let payload;
  let responseInfo;
  try {
    let response;
    while (true) {
      payload = completionPayload(upstream, body, options);
      response = await fetch(upstream.endpoint, {
        method: 'POST', redirect: 'manual', headers, signal: requestSignal, body: JSON.stringify(payload),
      });
      responseInfo = { httpStatus: response.status };
      if (response.ok) break;
      const optionalFields = options.json || options.level < (upstream.reasoning?.levels.length ?? 0);
      if (optionalFields && (response.status === 400 || response.status === 422)) {
        const next = fallbackOptions(upstream, options, await rejectionDetails(response));
        requestSignal.throwIfAborted();
        if (next) {
          options = next;
          retries += 1;
          continue;
        }
      } else {
        await response.body?.cancel();
      }
      const error = new Error(`Chat Completions HTTP ${response.status}`);
      error.upstreamStatus = response.status;
      throw error;
    }
    const { id, model: responseModel, usage, choices } = streaming ? await readTextStream(response, requestSignal, onDelta) : await response.json();
    const answer = choices?.[0];
    if (!answer?.message) throw new Error('Chat Completions 没有返回消息。');
    responseInfo = { ...responseInfo, id, finish_reason: answer.finish_reason, message: {
      role: answer.message.role, content: answer.message.content, tool_calls: answer.message.tool_calls
    } };
    if (returnCompletion) return { id, responseModel, usage, finishReason: answer.finish_reason, message: answer.message };
    return answer.message;
  } catch (error) {
    responseInfo = { ...responseInfo, error: error?.name || 'Error', message: error?.message || String(error) };
    throw error;
  } finally {
    onTrace?.(toolResult('chat.completions', {
      endpoint: upstream.endpoint.href, model: upstream.model,
      temperature: payload?.temperature, reasoning: payload?.reasoning?.effort ?? payload?.reasoning_effort,
      response_format: payload?.response_format?.type, compatibilityRetries: retries,
      ...(streaming ? { stream: true } : {}),
      tools: payload?.tools?.map(item => item.function.name),
      messages: body.messages.map(message => ({ ...message, content: Array.isArray(message.content)
        ? message.content.map(part => part.type === 'image_url' ? { type: part.type, sha256: imageHash, encoding: 'png' } : part)
        : message.content }))
    }, responseInfo, startedAt, responseInfo?.error ? 'error' : 'ok'));
  }
}
