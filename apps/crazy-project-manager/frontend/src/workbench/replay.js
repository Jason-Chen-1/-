import { mountReplay } from './replay-player.js';
import { language, t } from '../i18n.js';

const DATABASE = 'crazy-project-manager-presentation';
const time = () => performance.timeOrigin + performance.now();
let queueDatabase;

function openQueue() {
  queueDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('queue', { keyPath: 'key' });
      store.createIndex('session', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  return queueDatabase;
}

async function useQueue(mode, use) {
  const db = await openQueue();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('queue', mode);
    const result = use(transaction.objectStore('queue'));
    transaction.oncomplete = () => resolve(result?.result ?? null);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).catch(() => null);
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function createRecorder({ sessionId, getContext }) {
  const pageId = newId();
  const pending = new Map();
  let clientSeq = 0;
  let scheduled;
  let inflight;
  let closed = false;
  const preparing = new Set();
  const url = `/api/sessions/${sessionId}`;
  const recovered = useQueue('readonly', store => store.index('session').getAll(sessionId)).then(entries => {
    for (const entry of entries ?? []) if (!pending.has(entry.key)) pending.set(entry.key, entry);
  });

  function track(entry) {
    pending.set(entry.key, entry);
    const written = useQueue('readwrite', store => store.put(entry));
    preparing.add(written);
    written.finally(() => preparing.delete(written));
    clearTimeout(scheduled);
    if (!closed) scheduled = setTimeout(() => void flush(), 180);
    return written;
  }

  function record(type, data = {}) {
    const context = getContext() ?? {};
    const n = ++clientSeq;
    const item = { pageId, clientSeq: n, at: time(), observedSeq: context.seq ?? 0, type, data, context };
    track({ key: `${pageId}:${n}`, sessionId, kind: 'action', item });
  }

  async function post(suffix, data) {
    const response = await fetch(`${url}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(t(`回放资源提交失败 (${response.status})`, `Could not upload replay media (${response.status})`));
    return response.json();
  }

  async function remove(keys) {
    await useQueue('readwrite', store => { for (const key of keys) store.delete(key); });
    for (const key of keys) pending.delete(key);
  }

  async function flush() {
    clearTimeout(scheduled);
    scheduled = null;
    if (inflight) return inflight;
    inflight = (async () => {
      await recovered;
      await Promise.allSettled([...preparing]);
      try {
        const actions = Array.from(pending.values()).filter(entry => entry.kind === 'action');
        while (actions.length) {
          const batch = actions.splice(0, 36);
          const { received } = await post('presentation', { records: batch.map(entry => entry.item) });
          await remove(received.map(([page, index]) => `${page}:${index}`));
        }
        for (const entry of pending.values()) {
          if (entry.kind !== 'media') continue;
          const encoded = await dataUrl(entry.blob);
          await post('media', { ...entry.meta, mime: entry.blob.type, data: encoded.split(',')[1] });
          await remove([entry.key]);
        }
      } catch {
        if (!closed) scheduled = setTimeout(() => void flush(), 2200);
      }
      return { pending: pending.size };
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
      if (pending.size && !scheduled && !closed) scheduled = setTimeout(() => void flush(), 2200);
    }
  }

  async function media(blob, meta = {}) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error(t('录音为空', 'The recording is empty'));
    const at = time();
    const observedSeq = getContext()?.seq ?? 0;
    const hash = meta.hash || await digest(await blob.arrayBuffer());
    const key = `${pageId}:media:${hash ?? newId()}:${meta.messageId ?? ''}:${meta.segment ?? meta.segmentId ?? ''}`;
    await track({ key, sessionId, kind: 'media', blob, meta: { meta, hash, at, observedSeq } });
    return { hash, url: hash ? `/api/media/${hash}` : null };
  }

  function pagehide() {
    const items = Array.from(pending.values()).filter(entry => entry.kind === 'action').map(entry => entry.item);
    while (items.length) {
      const records = items.splice(0, 12);
      const body = new Blob([JSON.stringify({ records })], { type: 'application/json' });
      if (body.size < 60000) navigator.sendBeacon?.(`${url}/presentation`, body);
    }
  }

  const online = () => void flush();
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('online', online);
  void flush();
  return {
    record, flush, media,
    close() {
      closed = true;
      clearTimeout(scheduled);
      pagehide();
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('online', online);
    }
  };
}

const legacySprites = {
  zhou: '/assets/characters/rick.png',
  lin: '/assets/characters/june.png',
  tang: '/assets/characters/chad.png'
};
const mangaAtlases = {
  cast: '/assets/characters/manga-cast.png',
  employee: '/assets/characters/manga-employee.png'
};

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

async function resource(url, hash) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(t('回放资源不存在', 'Replay media is missing'));
  const blob = await response.blob();
  if (hash) {
    const actual = await digest(await blob.arrayBuffer());
    if (actual && actual !== hash) throw new Error(t('回放资源哈希不匹配', 'The replay media did not match its saved checksum'));
  }
  return dataUrl(blob);
}

async function embedImages(images, prefix, missing) {
  return Object.fromEntries(await Promise.all(Object.entries(images).map(async ([key, url]) => {
    try {
      return [key, await resource(url)];
    } catch {
      missing.add(`${prefix}-${key}`);
      return [key, null];
    }
  })));
}

async function offlineFile(bundle) {
  const [javascript, stylesheet] = await Promise.all(['replay-player.js', 'replay.css'].map(async filename => {
    const response = await fetch(`/${filename}`);
    if (!response.ok) throw new Error(t('回放播放器文件缺失。', 'The offline replay player files are missing.'));
    return response.text();
  }));
  const all = [...Object.entries(bundle.assets)];
  const embedded = {};
  const missing = new Set(bundle.missing);
  while (all.length) {
    const batch = all.splice(0, 6);
    await Promise.all(batch.map(async ([hash, asset]) => {
      try {
        embedded[hash] = { ...asset, url: await resource(asset.url, hash) };
      } catch {
        missing.add(hash);
      }
    }));
  }
  const artwork = bundle.atlases
    ? { atlases: await embedImages(bundle.atlases, 'manga', missing) }
    : { castImages: await embedImages(bundle.castImages, 'cast', missing) };
  const english = /^en(?:-|$)/i.test(bundle.language ?? language);
  const pageLanguage = english ? 'en' : 'zh-CN';
  const title = english ? 'Crazy Project Manager · Offline replay' : '疯狂的项目经理 · 离线回放';
  const filename = english ? 'offline-replay' : '整局回放';
  const rendered = { ...bundle, language: pageLanguage, assets: embedded, ...artwork, missing: [...missing] };
  const data = JSON.stringify(rendered).replaceAll('<', '\\u003c');
  const boot = `\nmountReplay(document.querySelector('#replay'), JSON.parse(document.querySelector('#replay-data').textContent));`;
  const html = `<!doctype html><html lang="${pageLanguage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${stylesheet}</style></head><body class="replay-document"><main id="replay"></main><script type="application/json" id="replay-data">${data}</script><script type="module">${javascript}${boot}</script></body></html>`;
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), `${bundle.theme.name}_${filename}_${bundle.untilSeq}.html`);
  return missing.size;
}

const button = (label, action) => {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
};

export function showReplay({ sessionId, recorder }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'replay-dialog';
  dialog.setAttribute('aria-labelledby', 'studio-replay-title');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'studio-replay-title';
  title.textContent = t('整局回放', 'Session replay');
  const actions = document.createElement('div');
  const player = document.createElement('main');
  const status = document.createElement('p');
  status.className = 'replay-status';
  status.setAttribute('role', 'status');
  let bundle = null;
  let mounted = null;
  const exportButton = button(t('下载离线回放', 'Download offline replay'), async () => {
    if (!bundle) return;
    const sealed = bundle;
    exportButton.disabled = true;
    status.textContent = t('正在打包本局海报与声轨…', 'Preparing posters and audio…');
    recorder?.record('ui.replay-export', { untilSeq: sealed.untilSeq });
    try {
      const missing = await offlineFile(sealed);
      status.textContent = missing
        ? t(`回放已下载，缺少 ${missing} 项资源。可同步资源后重新下载。`,
          `Replay downloaded with ${missing} missing ${missing === 1 ? 'file' : 'files'}. Sync the files and download again.`)
        : t('离线回放已下载。', 'Offline replay downloaded.');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      exportButton.disabled = false;
    }
  });
  exportButton.disabled = true;
  const refreshButton = button(t('同步资源', 'Sync files'), refresh);
  actions.append(refreshButton, exportButton, button(t('关闭', 'Close'), () => dialog.close()));
  header.append(title, actions);
  dialog.append(header, status, player);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    mounted?.destroy();
    recorder?.record('ui.replay-close');
    dialog.remove();
  }, { once: true });
  recorder?.record('ui.replay-open');
  dialog.showModal();
  void refresh();

  async function refresh() {
    refreshButton.disabled = true;
    status.textContent = t('正在读取会话…', 'Loading session…');
    try {
      const pending = await recorder?.flush();
      const response = await fetch(`/api/sessions/${sessionId}/replay?lang=${encodeURIComponent(language)}`, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(t('无法读取这局回放。', 'Could not load this replay.'));
      const result = await response.json();
      if (!dialog.open) return;
      const artwork = result.animation === 'manga-2' ? { atlases: mangaAtlases } : { castImages: legacySprites };
      bundle = { ...result, ...artwork, language };
      mounted?.destroy();
      mounted = mountReplay(player, bundle);
      exportButton.disabled = false;
      status.textContent = [
        pending?.pending ? t(`${pending.pending} 项操作或录音待同步。`, `${pending.pending} ${pending.pending === 1 ? 'action or recording is' : 'actions or recordings are'} waiting to sync.`) : '',
        bundle.missing.length ? t(`缺少 ${bundle.missing.length} 项资源。`, `${bundle.missing.length} ${bundle.missing.length === 1 ? 'file is' : 'files are'} missing.`) : ''
      ].filter(Boolean).join(' ');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      refreshButton.disabled = false;
    }
  }
}
