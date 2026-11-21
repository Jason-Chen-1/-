export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function hexBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

export function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export async function deriveKey(secret, purpose, algorithm, usages) {
  const bytes = hexBytes(secret);
  if (!bytes) throw new Error('Studio runtime secret is missing or invalid.');
  const key = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: textEncoder.encode('sunset-studio:v1'),
    info: textEncoder.encode(purpose),
  }, key, algorithm, false, usages);
}
