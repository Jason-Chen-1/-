export function joinBytes(chunks, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function decodeBase64(text) {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0));
}

export function encodeBase64(bytes) {
  let characters = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    characters += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(characters);
}

export function voiceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function isEnglishVoice(language) {
  return typeof language === 'string' && /^en(?:-|$)/i.test(language);
}
