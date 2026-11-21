import {deriveKey, fromBase64, hexBytes, textEncoder, toBase64} from './crypto.mjs';

const SESSION_SECONDS = 30 * 60;
const HMAC = {name: 'HMAC', hash: 'SHA-256'};

export function adminAccess(request, env, now = Date.now) {
  const {origin, protocol} = new URL(request.url);
  const secure = protocol === 'https:';
  const cookieName = secure ? '__Host-sunset-admin' : 'sunset-admin';
  const digest = hexBytes(env.STUDIO_ADMIN_HASH);
  const enabled = Boolean(digest && hexBytes(env.STUDIO_RUNTIME_SECRET));
  const signKey = () => deriveKey(env.STUDIO_RUNTIME_SECRET, 'admin-session', HMAC, ['sign', 'verify']);
  const sessionMessage = token => textEncoder.encode(`${origin}\n${env.STUDIO_ADMIN_HASH}\n${token}`);
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  return {
    enabled,
    async unlocked() {
      if (!enabled) return false;
      const saved = request.headers.get('Cookie')?.split(';')
        .map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
      const parts = saved?.slice(cookieName.length + 1).match(/^(\d{10,13})\.([\da-f]{32})\.([A-Za-z0-9+/]{43}=)$/);
      if (!parts || Number(parts[1]) <= now()) return false;
      try {
        return await crypto.subtle.verify('HMAC', await signKey(), fromBase64(parts[3]), sessionMessage(`${parts[1]}.${parts[2]}`));
      } catch {
        return false;
      }
    },
    async unlock(key) {
      if (!enabled || typeof key !== 'string' || !key || key.length > 256) return null;
      const supplied = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(key.trim())));
      let difference = 0;
      for (let index = 0; index < supplied.length; index++) difference |= supplied[index] ^ digest[index];
      if (difference) return null;
      const nonce = crypto.randomUUID().replaceAll('-', '');
      const token = `${now() + SESSION_SECONDS * 1000}.${nonce}`;
      const signature = await crypto.subtle.sign('HMAC', await signKey(), sessionMessage(token));
      return cookie(`${token}.${toBase64(new Uint8Array(signature))}`, SESSION_SECONDS);
    },
    lock: () => cookie('', 0),
  };
}
