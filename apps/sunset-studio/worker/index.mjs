import {assetResponse} from '../server/assets.mjs';
import {createSettingsStore} from '../server/settings-store.mjs';
import {createStudioApi} from '../server/site-api.mjs';

const assets = __SUNSET_ASSETS__;
const api = createStudioApi({
  getStore: env => createSettingsStore(env.DB, env.STUDIO_RUNTIME_SECRET),
  fetchImpl: (input, init) => fetch(input, init),
});

function decodeAsset(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default {
  fetch(request, env) {
    const {pathname} = new URL(request.url);
    if (pathname.startsWith('/api/')) return api(request, env);
    const name = pathname === '/' ? '/index.html' : pathname;
    const file = Object.hasOwn(assets, name) ? assets[name] : undefined;
    return assetResponse(request, pathname, file && {
      contentType: file.contentType,
      body: () => decodeAsset(file.base64),
    });
  },
};
