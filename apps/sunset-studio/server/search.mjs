import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {configureNetwork} from './network.mjs';
import {createSearch} from './search-core.mjs';
export {createSearch, normalizeSearchQuery, parseResults} from './search-core.mjs';

export function makeSearchServer({search = createSearch()} = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):8765$/.test(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/api/search') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      res.end(JSON.stringify(await search(url.searchParams.get('q'), {signal: controller.signal})));
    } catch (error) {
      if (res.destroyed) return;
      res.writeHead(502);
      res.end(JSON.stringify({error: error.message}));
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  configureNetwork();
  makeSearchServer().listen(8769, '127.0.0.1', () => console.log('Studio search: http://127.0.0.1:8769/api/search'));
}
