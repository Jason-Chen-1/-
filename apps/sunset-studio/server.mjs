import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {assetResponse, assetType} from './server/assets.mjs';
import {fishDefaults} from './server/fish-provider.mjs';
import {modelDefaults} from './server/model-provider.mjs';
import {configureNetwork} from './server/network.mjs';
import {createMemoryStore} from './server/settings-store.mjs';
import {createStudioApi} from './server/site-api.mjs';

export {normalizeBase} from './server/model-provider.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));

async function localAsset(request, pathname) {
  const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const contentType = assetType(name);
  const filename = path.resolve(root, name);
  let entry;
  if (contentType && filename.startsWith(root) && !name.split(/[\\/]/).some(segment => segment.startsWith('.'))) {
    const bytes = await readFile(filename).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
    });
    if (bytes) entry = {contentType, body: () => bytes};
  }
  return assetResponse(request, pathname, entry);
}

export function makeServer({fetchImpl, initialConfig = {}, adminKey, runtimeSecret} = {}) {
  const store = createMemoryStore({
    model: {
      ...modelDefaults, baseUrl: process.env.OPENAI_BASE_URL || modelDefaults.baseUrl,
      apiKey: process.env.OPENAI_API_KEY || '', model: process.env.OPENAI_MODEL || '', ...initialConfig,
    },
    fish: {...fishDefaults, apiKey: process.env.FISH_API_KEY || '', enabled: Boolean(process.env.FISH_API_KEY)},
  });
  const env = {
    STUDIO_ADMIN_HASH: adminKey ? createHash('sha256').update(adminKey).digest('hex') : '',
    STUDIO_RUNTIME_SECRET: runtimeSecret,
  };
  const api = createStudioApi({getStore: () => store, fetchImpl, allowLocalProvider: true});

  return http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      const url = new URL('http://' + host + req.url);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, {
        method: req.method, headers: req.headers, signal: abort.signal,
        ...(hasBody ? {body: Readable.toWeb(req), duplex: 'half'} : {}),
      });
      const response = url.pathname.startsWith('/api/') ? await api(request, env) : await localAsset(request, url.pathname);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, {signal: abort.signal});
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else if (!res.destroyed) res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  configureNetwork();
  const port = Number(process.env.PORT) || 8765;
  const server = makeServer({adminKey: process.env.STUDIO_ADMIN_KEY, runtimeSecret: process.env.STUDIO_RUNTIME_SECRET});
  server.listen(port, '127.0.0.1', () => console.log(`Sunset Studio: http://127.0.0.1:${port}/`));
}
