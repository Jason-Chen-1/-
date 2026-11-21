import {deriveKey, fromBase64, textDecoder, textEncoder, toBase64} from './crypto.mjs';

const AES = {name: 'AES-GCM', length: 256};
const missing = () => ({revision: 0, value: null});

export function createSettingsStore(db, secret) {
  const encryptionKey = () => deriveKey(secret, 'settings-storage', AES, ['encrypt', 'decrypt']);
  const options = (kind, revision, iv) => ({name: 'AES-GCM', iv, additionalData: textEncoder.encode(`${kind}:${revision}`)});

  return {
    async read(kind) {
      const row = await db.prepare('SELECT revision, encrypted_value FROM studio_settings WHERE kind = ?').bind(kind).first();
      if (!row) return missing();
      const [iv, content] = row.encrypted_value.split('.');
      const plain = await crypto.subtle.decrypt(options(kind, row.revision, fromBase64(iv)), await encryptionKey(), fromBase64(content));
      return {revision: row.revision, value: JSON.parse(textDecoder.decode(plain))};
    },
    async write(kind, expected, value) {
      const revision = expected + 1;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(options(kind, revision, iv), await encryptionKey(), textEncoder.encode(JSON.stringify(value)));
      const encrypted = `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
      const operation = expected === 0
        ? db.prepare('INSERT OR IGNORE INTO studio_settings (kind, revision, encrypted_value) VALUES (?, ?, ?)').bind(kind, revision, encrypted)
        : db.prepare('UPDATE studio_settings SET revision = ?, encrypted_value = ? WHERE kind = ? AND revision = ?').bind(revision, encrypted, kind, expected);
      return (await operation.run()).meta.changes === 1;
    },
  };
}

export function createMemoryStore(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([kind, value]) => [kind, {revision: 1, value}]));
  return {
    read: async kind => entries.get(kind) ?? missing(),
    async write(kind, expected, value) {
      if ((entries.get(kind)?.revision ?? 0) !== expected) return false;
      entries.set(kind, {revision: expected + 1, value});
      return true;
    },
  };
}
