import assets, { contents } from 'studio:static-assets';

const routeAliases = Object.freeze({
  '/': '/index.html',
  '/home.html': '/index.html',
  '/workbench': '/workbench.html',
  '/reservation': '/reservation.html'
});

function rangeOf(header, total) {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  return { start, end, valid: start < total && start <= end };
}

function assetPath(pathname) {
  try {
    return Object.hasOwn(routeAliases, pathname) ? routeAliases[pathname] : decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

export function embeddedStaticAsset(pathname) {
  const entry = assets[pathname];
  return entry?.[3] ? contents[entry[1]] : undefined;
}

export async function serveStatic(request, env) {
  const url = new URL(request.url);
  const pathname = assetPath(url.pathname);
  if (!pathname || !Object.hasOwn(assets, pathname)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });

  if (env?.ASSETS?.fetch) {
    url.pathname = pathname;
    try {
      const response = await env.ASSETS.fetch(new Request(url, request));
      if (response.ok || response.status === 304) return response;
    } catch {
      // Embedded assets remain available when the optional binding is unavailable.
    }
  }

  const [mime, digest, length] = assets[pathname];
  const encoded = embeddedStaticAsset(pathname);
  if (encoded === undefined) return null;
  const etag = `"${digest}"`;
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Accept-Ranges': 'bytes',
    ETag: etag
  });
  const cached = request.headers.get('If-None-Match')?.split(',').some((value) => {
    const tag = value.trim().replace(/^W\//, '');
    return tag === etag || tag === '*';
  });
  if (cached) return new Response(null, { status: 304, headers });

  const expected = request.headers.get('If-Range');
  const range = expected && expected !== etag ? null : rangeOf(request.headers.get('Range'), length);
  if (range && !range.valid) {
    headers.set('Content-Range', `bytes */${length}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${length}`);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : length));
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const bytes = typeof Uint8Array.fromBase64 === 'function'
    ? Uint8Array.fromBase64(encoded)
    : Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  return new Response(body, { status, headers });
}
