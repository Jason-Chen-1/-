import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { volcSentenceASR, volcStreamASRResources } from './runtime-config.mjs';

const endpoint = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const volcengineRealtimeResource = volcStreamASRResources[0];

function encodeFrame(type, serialization, data, { final = false, sequence } = {}) {
  const payload = gzipSync(data);
  const numbered = sequence !== undefined;
  const flags = (numbered ? 1 : 0) | (final ? 2 : 0);
  const sizeOffset = numbered ? 8 : 4;
  const frame = new Uint8Array(sizeOffset + 4 + payload.byteLength);
  frame.set([0x11, type << 4 | flags, serialization << 4 | 1, 0]);
  const view = new DataView(frame.buffer);
  if (numbered) view.setInt32(4, final ? -sequence : sequence);
  view.setUint32(sizeOffset, payload.byteLength);
  frame.set(payload, sizeOffset + 4);
  return frame;
}

export function volcengineRecognitionProtocol(config, resourceId) {
  const sentence = config.mode === 'volcengine-sentence';
  const resource = sentence ? config.resourceId ?? resourceId : resourceId;
  const requestId = randomUUID();
  let sequence = 2;
  return {
    url: sentence ? volcSentenceASR : endpoint,
    headers: {
      'X-Api-Key': config.key,
      'X-Api-Resource-Id': volcStreamASRResources.includes(resource) ? resource : volcengineRealtimeResource,
      'X-Api-Request-Id': requestId,
      ...(!sentence && { 'X-Api-Connect-Id': requestId, 'X-Api-Sequence': '-1' }),
    },
    start: encodeFrame(1, 1, new TextEncoder().encode(JSON.stringify({
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel', enable_itn: true, enable_punc: true,
        ...(!sentence && { enable_nonstream: true }),
        result_type: 'full', show_utterances: true,
      },
    })), { sequence: sentence ? 1 : undefined }),
    // The official sentence SDK keeps the JSON serialization flag on its gzipped PCM audio frames.
    audio: (bytes, final = false) => encodeFrame(2, sentence ? 1 : 0, bytes, { final, sequence: sentence ? sequence++ : undefined }),
    read: decodeVolcengineRecognition,
  };
}

function decodeVolcengineRecognition(bytes) {
  const headerSize = (bytes[0] & 0x0f) * 4;
  if (bytes[0] >> 4 !== 1 || headerSize < 4 || bytes.byteLength < headerSize + 4) {
    throw new Error('Invalid Volcengine recognition frame');
  }
  const type = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const compression = bytes[2] & 0x0f;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codeOffset = headerSize + ((flags & 1) ? 4 : 0) + ((flags & 4) ? 4 : 0);
  const sizeOffset = codeOffset + (type === 15 ? 4 : 0);
  const payloadOffset = sizeOffset + 4;
  if (bytes.byteLength < payloadOffset || view.getUint32(sizeOffset) !== bytes.byteLength - payloadOffset) {
    throw new Error('Invalid Volcengine recognition payload length');
  }
  if (type === 15) return { errorCode: view.getUint32(codeOffset) };
  if (type !== 9 || bytes[2] >> 4 !== 1 || compression > 1) {
    throw new Error('Unsupported Volcengine recognition frame');
  }
  const payload = bytes.subarray(payloadOffset);
  const decoded = compression === 1 && payload.byteLength ? gunzipSync(payload, { maxOutputLength: 1024 * 1024 }) : payload;
  const response = decoded.byteLength ? JSON.parse(new TextDecoder().decode(decoded)) : {};
  if (Number.isInteger(response.code) && response.code !== 20000000 && response.code !== 0) {
    return { errorCode: response.code };
  }
  const { text, utterances } = response.result ?? {};
  return {
    ready: true,
    draft: typeof text === 'string' ? text : undefined,
    stable: Array.isArray(utterances) && utterances.length > 0 && utterances.every(line => line.definite === true),
    done: Boolean(flags & 2),
  };
}
