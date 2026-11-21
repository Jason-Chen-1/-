import { Buffer } from 'node:buffer';
import { joinBytes } from './voice-bytes.mjs';

import { amdImageModel, amdImageRatios } from './runtime-config.mjs';
export { amdImageRatios } from './runtime-config.mjs';

const origin = 'https://h3.oneclickamd.ai';
export const amdImageMaxReferences = 3;
const turboSteps = 8;
const apiLimit = 64 * 1024;
const imageLimit = 8 * 1024 * 1024;
const referenceUriLimit = 30_000_000;
const pngDataPrefix = 'data:image/png;base64,';
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const messages = {
  'invalid-input': 'AMD 图像生成参数无效。',
  'missing-key': '请配置 AMD Creative Hub 个人 API Key。',
  unauthorized: 'AMD Creative Hub 拒绝访问，请检查个人 API Key 与模型权限。',
  'insufficient-credits': 'AMD Creative Hub 的生成额度不足。',
  'queue-full': 'AMD Creative Hub 的待处理任务已满。',
  'rate-limited': 'AMD Creative Hub 请求过于频繁。',
  'content-policy': 'AMD Creative Hub 拒绝了这条生图提示词。',
  'task-not-found': 'AMD Creative Hub 找不到该图像任务。',
  'expired-download': 'AMD 图像下载链接已无法访问。',
  'invalid-download': 'AMD 返回了无法验证的图像下载地址。',
  'invalid-image': 'AMD 没有返回有效的 PNG 图像。',
  'image-too-large': 'AMD 图像超过工作台可接收的大小。',
  'invalid-response': 'AMD Creative Hub 返回了无效的任务数据。',
  'unconfirmed-submission': 'AMD 没有确认生成请求是否已受理，请在 AMD 任务列表确认。',
  cancelled: 'AMD 图像请求已取消。',
  timeout: '等待 AMD Creative Hub 响应超时。',
  unavailable: 'AMD Creative Hub 暂时不可用。',
};

export class AmdImageError extends Error {
  constructor(code, { retryable = false, status, requestId } = {}) {
    super(messages[code]);
    this.name = 'AmdImageError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (typeof requestId === 'string' && /^req_[a-z0-9_-]{1,80}$/i.test(requestId)) this.requestId = requestId;
  }
}

async function readLimited(response, limit, errorCode) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new AmdImageError(errorCode);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return joinBytes(chunks, total);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new AmdImageError(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response, errorCode) {
  const bytes = await readLimited(response, apiLimit, errorCode);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AmdImageError(errorCode); }
}

async function unsuccessful(response, operation) {
  const { status } = response;
  const download = operation === 'download';
  let details;
  if (download) await response.body?.cancel().catch(() => {});
  else details = await readJson(response, 'invalid-response').catch(() => null);

  let code;
  if (download && [401, 403, 404, 410].includes(status)) code = 'expired-download';
  else if (status === 400 && details?.error?.type === 'content_policy_violation') code = 'content-policy';
  else code = {
    400: 'invalid-input', 401: 'unauthorized', 402: 'insufficient-credits', 403: 'unauthorized',
    404: 'task-not-found', 409: 'queue-full', 429: 'rate-limited',
  }[status];
  const temporary = status === 408 || status >= 500;
  if (!code) code = temporary
    ? operation === 'submit' ? 'unconfirmed-submission' : 'unavailable'
    : download ? 'invalid-download' : 'invalid-response';
  return new AmdImageError(code, {
    status, requestId: details?.request_id,
    retryable: status === 429 || (temporary && operation !== 'submit'),
  });
}

async function request(url, { operation, key, body, signal }, read) {
  const submit = operation === 'submit';
  const download = operation === 'download';
  const deadline = AbortSignal.timeout(download ? 20000 : 12000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (requestSignal.aborted) throw new AmdImageError('cancelled');
  try {
    const response = await fetch(url, {
      method: submit ? 'POST' : 'GET', body, signal: requestSignal, redirect: 'manual',
      headers: {
        Accept: download ? 'image/png' : 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(submit ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw await unsuccessful(response, operation);
    const result = await read(response);
    requestSignal.throwIfAborted();
    return result;
  } catch (error) {
    if (error instanceof AmdImageError) throw error;
    // A transport failure after POST cannot tell us whether the provider created the task.
    if (submit) throw new AmdImageError('unconfirmed-submission');
    if (deadline.aborted || signal?.reason?.name === 'TimeoutError') {
      throw new AmdImageError('timeout', { retryable: true });
    }
    if (signal?.aborted) throw new AmdImageError('cancelled');
    throw new AmdImageError('unavailable', { retryable: true });
  }
}

function validateKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new AmdImageError('missing-key');
  if (!/^[\x21-\x7e]{1,1024}$/.test(key)) throw new AmdImageError('unauthorized');
}

const validId = value => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value);

function downloadUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new AmdImageError('invalid-download');
  let url;
  try { url = new URL(value); } catch { throw new AmdImageError('invalid-download'); }
  if (url.origin !== origin || url.pathname !== '/v1/files/download' || url.username || url.password ||
      url.hash || !url.searchParams.get('exp') || !url.searchParams.get('sig')) {
    throw new AmdImageError('invalid-download');
  }
  return url.href;
}

function assertPng(bytes, code) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 45 || !pngSignature.every((part, index) => bytes[index] === part) ||
      data.getUint32(8) !== 13 || data.getUint32(12) !== 0x49484452 ||
      data.getUint32(bytes.byteLength - 8) !== 0x49454e44) throw new AmdImageError(code);
  const width = data.getUint32(16);
  const height = data.getUint32(20);
  if (!width || !height || width * height > 16 * 1024 * 1024) throw new AmdImageError(code);
}

function referencePng(url) {
  if (typeof url !== 'string' || !url.startsWith(pngDataPrefix) || url.length > referenceUriLimit) {
    throw new AmdImageError('invalid-input');
  }
  const base64 = url.slice(pngDataPrefix.length);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AmdImageError('invalid-input');
  assertPng(Buffer.from(base64, 'base64'), 'invalid-input');
  return url;
}

export function normalizeAmdImageRequest({ prompt, aspectRatio = '1:1', referenceImages } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text || text.length > 16000 || [...text].length > 8000 || !amdImageRatios.includes(aspectRatio)) {
    throw new AmdImageError('invalid-input');
  }
  if (referenceImages === undefined) return { prompt: text, aspectRatio };
  if (!Array.isArray(referenceImages) || referenceImages.length > amdImageMaxReferences) throw new AmdImageError('invalid-input');
  return { prompt: text, aspectRatio, referenceImages: Array.from(referenceImages, referencePng) };
}

export async function submitAmdImage({ key, signal, ...requestInput }) {
  validateKey(key);
  const { prompt, aspectRatio, referenceImages = [] } = normalizeAmdImageRequest(requestInput);
  const content = [{ type: 'text', text: prompt }, ...referenceImages.map(url => ({ type: 'image_url', role: 'reference', image_url: { url } }))];
  const body = JSON.stringify({ model: amdImageModel, content, aspect_ratio: aspectRatio, steps: turboSteps, quality: 'standard' });
  return request(`${origin}/v2/video_generation`, { operation: 'submit', key, body, signal }, async response => {
    const { task_id: taskId } = (await readJson(response, 'unconfirmed-submission')) ?? {};
    if (!validId(taskId)) throw new AmdImageError('unconfirmed-submission');
    return taskId;
  });
}

export async function queryAmdImage({ key, taskId, signal }) {
  validateKey(key);
  if (!validId(taskId)) throw new AmdImageError('invalid-input');
  return request(`${origin}/v2/query/video_generation/${taskId}`, { operation: 'query', key, signal }, async response => {
    const { task } = (await readJson(response, 'invalid-response')) ?? {};
    if (!task || (task.id !== undefined && task.id !== taskId) || (task.model !== undefined && task.model !== amdImageModel) ||
        (task.modality !== undefined && task.modality !== 'image') ||
        (task.x_steps != null && task.x_steps !== turboSteps)) throw new AmdImageError('invalid-response');
    if (task.status === 'queued' || task.status === 'running') return { status: 'pending' };
    if (task.status === 'failed' || task.status === 'cancelled') return { status: 'failed' };
    if (task.status !== 'succeeded' || (task.content?.type !== undefined && task.content.type !== 'image')) {
      throw new AmdImageError('invalid-response');
    }
    return { status: 'succeeded', url: downloadUrl(task.content?.url) };
  });
}

export async function downloadAmdImage({ url, signal }) {
  return request(downloadUrl(url), { operation: 'download', signal }, async response => {
    const bytes = await readLimited(response, imageLimit, 'image-too-large');
    assertPng(bytes, 'invalid-image');
    return { bytes, mime: 'image/png' };
  });
}
