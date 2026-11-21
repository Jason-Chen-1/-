const types = {
  css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', mp3: 'audio/mpeg', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8',
  webp: 'image/webp',
};

export function assetType(path) {
  const extension = path.split('.').at(-1);
  return Object.hasOwn(types, extension) ? types[extension] : undefined;
}

export function assetResponse(request, pathname, entry) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}});
  if (!entry) return new Response('Not found', {status: 404});
  return new Response(request.method === 'HEAD' ? null : entry.body(), {headers: {
    'Content-Type': entry.contentType,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  }});
}
