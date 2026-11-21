import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { parseToolCallArguments } from '@earendil-works/pi-ai/utils/json-parse';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { chatCompletion } from './chat-provider.mjs';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const imageLimit = 14_000_000;
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function transportError(message) {
  return Object.assign(new Error(message), { posterTransport: true });
}

function partsOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
}

function textOf(content) {
  return partsOf(content).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

function imagePart({ mimeType, data }) {
  if (!imageTypes.has(mimeType) || typeof data !== 'string' || data.length > imageLimit || !/^[a-z0-9+/]+={0,2}$/i.test(data)) {
    throw transportError('小乙的模型请求包含无法读取的内嵌图片。');
  }
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } };
}

function userContent(content) {
  if (typeof content === 'string') return content;
  return partsOf(content).flatMap(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
    return part?.type === 'image' ? [imagePart(part)] : [];
  });
}

function assistantRequest(message, native) {
  const text = textOf(message.content);
  const calls = partsOf(message.content).filter(part => part?.type === 'toolCall');
  if (!calls.length) return text ? { role: 'assistant', content: text } : null;
  if (native) {
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map(({ id, name, arguments: args }) => ({
        id, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })),
    };
  }
  return {
    role: 'assistant',
    content: JSON.stringify({
      ...(text ? { text } : {}),
      tools: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    }),
  };
}

function appendToolResults(messages, results, native) {
  if (!results.length) return;
  const outputs = results.map(result => ({
    id: result.toolCallId, name: result.toolName, isError: result.isError === true, text: textOf(result.content),
    images: partsOf(result.content).filter(part => part?.type === 'image').map(imagePart),
  }));
  const images = outputs.flatMap(output => output.images);
  if (native) {
    for (const output of outputs) {
      messages.push({
        role: 'tool', tool_call_id: output.id,
        content: output.text || (output.images.length ? 'See the attached image.' : '{}'),
      });
    }
    if (images.length) messages.push({ role: 'user', content: images });
  } else {
    const feedback = JSON.stringify({
      toolResults: outputs.map(({ id, name, isError, text }) => ({ id, name, isError, text })),
    });
    messages.push({ role: 'user', content: images.length ? [{ type: 'text', text: feedback }, ...images] : feedback });
  }
  results.length = 0;
}

function attachPreview(messages, preview) {
  if (!preview) return;
  const url = preview.imageDataUrl;
  if (typeof url !== 'string' || url.length > imageLimit || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(url)) {
    throw transportError('小乙需要当前工作稿的有效 PNG。');
  }
  const latest = messages.at(-1);
  const picture = [
    { type: 'text', text: 'This is the latest rendered PNG of the working poster. Inspect it before continuing.' },
    { type: 'image_url', image_url: { url } },
  ];
  if (latest?.role !== 'user') {
    messages.push({ role: 'user', content: picture });
    return;
  }
  const content = partsOf(latest.content);
  if (!content.some(part => part.type === 'image_url' && part.image_url.url === url)) latest.content = [...content, ...picture];
}

function requestMessages(transcript, tools, native, preview) {
  const prompt = getCurrentSystemPrompt(transcript);
  const jsonProtocol = !native && tools.length ? [
    'Transport uses JSON for canvas tools. Return one object with a tools array. Each tool has name, arguments, and optionally id.',
    'Use the toolResults sent by the application to repair a rejected call or continue inspecting/editing. Request submit_draft to deliver.',
    'Supported tools and argument schemas are ' + JSON.stringify(tools.map(tool => tool.function)),
  ].join('\n') : '';
  const system = [prompt, jsonProtocol].filter(Boolean).join('\n\n');
  const messages = system ? [{ role: 'system', content: system }] : [];
  const toolResults = [];
  for (const message of transcript) {
    if (message.role === 'system') continue;
    if (message.role === 'toolResult') {
      toolResults.push(message);
      continue;
    }
    appendToolResults(messages, toolResults, native);
    if (message.role === 'user') {
      const content = userContent(message.content);
      if (content.length) messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const assistant = assistantRequest(message, native);
      if (assistant) messages.push(assistant);
    }
  }
  appendToolResults(messages, toolResults, native);
  attachPreview(messages, preview);
  return messages;
}

function piCall({ id, name, args }, redact) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
    throw transportError('线上模型的工具调用缺少有效的 ID 或名称。');
  }
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  const parsed = parseToolCallArguments(raw);
  if (parsed.argumentsError) parsed.argumentsError = redact(parsed.argumentsError).slice(0, 960);
  return { block: { type: 'toolCall', id, name, ...parsed }, delta: parsed.argumentsError ? redact(raw).slice(0, 960) : raw };
}

function truncatedReply(calls) {
  const ids = new Set();
  const blocks = [];
  for (const { id, name } of calls) {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || ids.has(id)) continue;
    ids.add(id);
    blocks.push({ block: {
      type: 'toolCall', id, name, arguments: {},
      argumentsError: 'The model response reached its token limit. Retry with a smaller, complete tool call.',
    } });
  }
  return { blocks, json: false, stopReason: 'length' };
}

function jsonCalls(text, requestIndex) {
  const copy = text.trim();
  if (!/^(?:\{|\x60\x60\x60)/.test(copy)) return null;
  let envelope;
  try {
    envelope = JSON.parse(copy.replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !['tools', 'commands', 'operations', 'speech', 'reply', 'clarification', 'tool_calls'].some(field => Object.hasOwn(envelope, field))) {
    return null;
  }
  const entries = [...(Array.isArray(envelope.tools) ? envelope.tools : Array.isArray(envelope.tool_calls) ? envelope.tool_calls : [])];
  if (Array.isArray(envelope.commands)) entries.push({ name: 'run_canvas', arguments: { commands: envelope.commands } });
  if (Array.isArray(envelope.operations)) entries.push({ name: 'edit_poster', arguments: { operations: envelope.operations } });
  if (!entries.length && (envelope.speech || envelope.reply)) {
    entries.push({ name: 'submit_draft', arguments: { speech: envelope.speech ?? envelope.reply, label: envelope.label } });
  }
  const toolProgress = entries.some(entry => (entry?.name ?? entry?.function?.name) !== 'submit_draft')
    ? envelope.progress ?? envelope.speech : undefined;
  const spoken = [envelope.clarification, envelope.text, toolProgress].find(value => typeof value === 'string');
  return {
    text: spoken ?? '',
    calls: entries.map((entry, index) => ({
      id: entry?.id ?? `studio_json_${requestIndex}_${index}`, name: entry?.name ?? entry?.function?.name,
      args: entry?.arguments ?? entry?.function?.arguments,
    })),
  };
}

function replyBlocks(result, requestIndex, redact) {
  const { message, finishReason } = result;
  const nativeCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(call => ({ id: call?.id, name: call?.function?.name, args: call?.function?.arguments }))
    : [];
  if (finishReason === 'length') return truncatedReply(nativeCalls);
  if (message.refusal || finishReason === 'content_filter') throw transportError('线上模型未返回小乙可用的答复。');
  const text = textOf(message.content);
  const json = nativeCalls.length ? null : jsonCalls(text, requestIndex);
  const calls = json?.calls ?? nativeCalls;
  const spoken = json ? json.text : text;
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw transportError('线上模型重复使用了工具调用 ID。');
  const blocks = calls.map(call => piCall(call, redact));
  if (spoken.trim()) blocks.unshift({ block: { type: 'text', text: spoken }, delta: spoken });
  if (!blocks.length || (finishReason === 'tool_calls' && !calls.length)) throw transportError('线上模型没有返回工具调用或可用文字。');
  return { blocks, json: Boolean(json), stopReason: calls.length ? 'toolUse' : 'stop' };
}

function usageOf(usage) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const prompt = count(usage?.prompt_tokens);
  const cacheRead = Math.min(prompt, count(usage?.prompt_tokens_details?.cached_tokens));
  const output = count(usage?.completion_tokens);
  const reportedCost = usage?.cost;
  return {
    input: prompt - cacheRead, output, cacheRead, cacheWrite: 0,
    totalTokens: count(usage?.total_tokens) || prompt + output,
    ...(Number.isFinite(usage?.completion_tokens_details?.reasoning_tokens)
      ? { reasoning: count(usage.completion_tokens_details.reasoning_tokens) } : {}),
    cost: Number.isFinite(reportedCost)
      ? { ...zeroCost, total: reportedCost, totalFromProvider: true } : { ...zeroCost },
  };
}

function publishReply(stream, message, blocks, stopReason) {
  const snapshot = () => ({ ...message, content: [...message.content] });
  stream.push({ type: 'start', partial: snapshot() });
  for (const { block, delta } of blocks) {
    const contentIndex = message.content.length;
    if (block.type === 'text') {
      message.content.push({ type: 'text', text: '' });
      stream.push({ type: 'text_start', contentIndex, partial: snapshot() });
      message.content[contentIndex] = block;
      stream.push({ type: 'text_delta', contentIndex, delta, partial: snapshot() });
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: snapshot() });
    } else {
      message.content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: {} });
      stream.push({ type: 'toolcall_start', contentIndex, partial: snapshot() });
      message.content[contentIndex] = block;
      if (delta) stream.push({ type: 'toolcall_delta', contentIndex, delta, partial: snapshot() });
      stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: snapshot() });
    }
  }
  message.stopReason = stopReason;
  stream.push({ type: 'done', reason: stopReason, message });
}

function failureOf(error, signal) {
  if (error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError') {
    return Object.assign(new Error('小乙的线上模型请求超时。'), { name: 'TimeoutError' });
  }
  if (signal?.aborted || error?.name === 'AbortError') {
    return Object.assign(new Error('小乙的模型请求已取消。'), { name: 'AbortError' });
  }
  if (Number.isInteger(error?.upstreamStatus)) {
    return Object.assign(new Error('小乙的线上模型返回 HTTP ' + error.upstreamStatus + '。'), { upstreamStatus: error.upstreamStatus });
  }
  return error?.posterTransport ? new Error(error.message) : new Error('小乙的线上模型请求失败。');
}

export function createPosterPiTransport(upstream, { sessionId, onTrace, getPreview, temperature = 0.2 } = {}) {
  const provider = { ...upstream, timeout: Math.max(upstream.timeout ?? 0, 38_000) };
  const model = {
    id: provider.model, name: provider.model, api: 'openai-completions', provider: 'studio-chat',
    baseUrl: provider.endpoint.href, reasoning: Boolean(provider.reasoning), input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const bearer = provider.headers?.Authorization?.replace(/^Bearer\s+/i, '');
  const redact = text => bearer ? text.replaceAll(bearer, '[redacted]') : text;
  const emitTrace = onTrace && (trace => {
    const sanitized = bearer ? JSON.parse(JSON.stringify(trace, (_key, value) =>
      typeof value === 'string' ? redact(value) : value)) : trace;
    onTrace(sanitized);
  });
  let native = true;
  let requestIndex = 0;
  let failure;

  function streamFn(_model, { messages: transcript }, options = {}) {
    const stream = createAssistantMessageEventStream();
    const timestamp = Date.now();
    const index = ++requestIndex;
    failure = undefined;
    void (async () => {
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], usage: usageOf(), stopReason: 'pending', timestamp };
      const signal = options.signal;
      try {
        signal?.throwIfAborted();
        const preview = await getPreview?.();
        if (getPreview && !preview?.imageDataUrl) throw transportError('小乙需要当前工作稿的 PNG。');
        signal?.throwIfAborted();
        const tools = getCurrentTools(transcript).map(tool => ({
          type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        const send = useNative => chatCompletion(provider, {
          messages: requestMessages(transcript, tools, useNative, preview),
          ...(useNative && tools.length ? { tools } : {}),
          temperature: options.temperature ?? temperature,
        }, {
          sessionId: options.sessionId ?? sessionId, role: 'yi', signal, onTrace: emitTrace,
          imageHash: preview?.imageHash, jsonMode: !useNative && tools.length > 0, returnCompletion: true,
        });
        let result;
        try {
          result = await send(native);
        } catch (error) {
          if (!native || !tools.length || ![400, 422].includes(error?.upstreamStatus)) throw error;
          native = false;
          result = await send(false);
        }
        signal?.throwIfAborted();
        const reply = replyBlocks(result, index, redact);
        if (reply.json) native = false;
        if (typeof result.id === 'string') message.responseId = result.id;
        if (typeof result.responseModel === 'string') message.responseModel = result.responseModel;
        if (typeof result.finishReason === 'string') message.rawStopReason = result.finishReason;
        message.usage = usageOf(result.usage);
        publishReply(stream, message, reply.blocks, reply.stopReason);
      } catch (error) {
        failure = failureOf(error, signal);
        message.stopReason = failure.name === 'AbortError' ? 'aborted' : 'error';
        message.errorMessage = redact(failure.message);
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally {
        stream.end();
      }
    })();
    return stream;
  }

  function historicalReply(text, timestamp) {
    return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text }], usage: usageOf(), stopReason: 'stop', timestamp };
  }

  return { model, streamFn, historicalReply, getFailure: () => failure };
}
