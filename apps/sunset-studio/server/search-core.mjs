import {fetchWithoutRedirect} from './upstream.mjs';

const CACHE_MS = 5 * 60 * 1000;
const MAX_RESULTS = 5;
const SITE = /\bsite:([\w.-]+\.[a-z]{2,})\b/gi;

export function normalizeSearchQuery(raw, apiKey = '') {
  const query = typeof raw === 'string' ? raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (query.length < 2 || query.length > 220) throw new Error('搜索关键词应为 2 至 220 个字符。');
  if ((apiKey?.length >= 8 && query.includes(apiKey)) || /\b(?:sk-|Bearer\s+)[a-z\d_-]{12,}/i.test(query)) {
    throw new Error('搜索关键词包含凭据，请仅使用公开信息。');
  }
  return query;
}

function plainText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
      const named = {'&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' '};
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const code = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function resultOf(item) {
  try {
    const {title, url, snippet} = item;
    const link = new URL(url);
    if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || link.href.length > 1800) return null;
    // Search citations sometimes append numeric snippet markers to the actual link.
    if (/^(#\d+)+$/.test(link.hash)) link.hash = '';
    return {
      title: plainText(title).slice(0, 180) || link.hostname,
      url: link.href,
      snippet: plainText(snippet).slice(0, 360),
      domain: link.hostname,
    };
  } catch {
    return null;
  }
}

function uniqueResults(items, domains = [], limit = MAX_RESULTS) {
  const seen = new Set();
  const results = [];
  for (const item of items) {
    const result = resultOf(item);
    if (!result || seen.has(result.url)) continue;
    if (domains.length && !domains.some(domain => result.domain === domain || result.domain.endsWith('.' + domain))) continue;
    seen.add(result.url);
    results.push(result);
    if (results.length === limit) break;
  }
  return results;
}

export function parseResults(xml) {
  const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const tag = name => item.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i'))?.[1];
    return {title: tag('title'), url: plainText(tag('link')), snippet: tag('description')};
  });
  return uniqueResults(items, [], 12);
}

async function boundedText(response, limit = 750_000) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('搜索服务暂不可用。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('搜索响应过大。');
      }
      text += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function nativeProvider(config) {
  if (!config?.apiKey) return '';
  try {
    const {origin} = new URL(config.baseUrl);
    if (origin === 'https://api.deepseek.com') return 'DeepSeek Web Search';
    if (origin === 'https://api.openai.com') return 'OpenAI Web Search';
  } catch {}
  return '';
}

async function nativeSearch(fetchImpl, provider, config, query, domains, signal) {
  const deepseek = provider === 'DeepSeek Web Search';
  const system = 'Use web search for the public query. Return the original source links. Use the tool rather than answering from memory. Prefer primary sources.';
  const request = 'Use the web search tool now to find direct public source pages for: ' + query;
  const endpoint = deepseek ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/responses';
  const payload = deepseek ? {
    model: 'deepseek-flash', max_tokens: 150, thinking: {type: 'disabled'}, tools: [{type: 'deepseek_web_search'}],
    messages: [{role: 'system', content: system}, {role: 'user', content: request}],
  } : {
    model: config.model, store: false, input: request, instructions: system, max_output_tokens: 500,
    tools: [{type: 'web_search', search_context_size: 'low', ...(domains.length ? {filters: {allowed_domains: domains}} : {})}],
    tool_choice: {type: 'web_search'}, include: ['web_search_call.action.sources'],
  };
  const response = await fetchWithoutRedirect(fetchImpl, endpoint, {
    method: 'POST', signal,
    headers: {Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = JSON.parse(await boundedText(response, 2_000_000));
  if (deepseek) {
    const groups = data.choices?.[0]?.message?.server_tool_calls || [];
    return groups.flatMap(group => (group.calls || [])
      .filter(call => call.type === 'deepseek_web_search' && call.status === 'completed')
      .flatMap(call => call.sources || []));
  }
  const calls = (data.output || []).filter(item => item.type === 'web_search_call' && item.status === 'completed');
  if (!calls.length) return [];
  const citations = (data.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || []).flatMap(part => part.annotations || []).filter(annotation => annotation.type === 'url_citation');
  return [...citations, ...calls.flatMap(call => call.action?.sources || [])];
}

async function publicSearch(fetchImpl, query, domains, signal) {
  const topic = query.replace(SITE, '').trim();
  const language = /[\u3400-\u9fff]/.test(topic) ? 'zh' : 'en';
  const wikiHost = language + '.wikipedia.org';
  const wikiAllowed = !domains.length || domains.some(domain => wikiHost === domain || wikiHost.endsWith('.' + domain));
  const wikiUrl = new URL('https://' + wikiHost + '/w/api.php');
  wikiUrl.search = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: topic, gsrlimit: '4', prop: 'extracts',
    exintro: '1', explaintext: '1', exchars: '800', format: 'json', utf8: '1',
  });
  const bingUrl = new URL('https://www.bing.com/search');
  bingUrl.search = new URLSearchParams({format: 'rss', count: '10', q: query});
  const [bing, wiki] = await Promise.allSettled([
    fetchWithoutRedirect(fetchImpl, bingUrl.href, {signal, headers: {Accept: 'application/rss+xml, application/xml'}})
      .then(boundedText).then(parseResults),
    wikiAllowed && topic ? fetchWithoutRedirect(fetchImpl, wikiUrl.href, {signal}).then(boundedText).then(JSON.parse) : null,
  ]);
  const words = [...new Set(topic.toLowerCase().match(/[a-z\d]{3,}/g) || [])];
  const indexed = (bing.value || []).filter(({title, snippet}) => {
    const text = (title + ' ' + snippet).toLowerCase();
    return words.filter(word => text.includes(word)).length >= Math.min(2, words.length);
  });
  const encyclopedia = Object.values(wiki.value?.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .map(page => ({
      title: page.title, url: 'https://' + wikiHost + '/wiki/' + encodeURIComponent(page.title.replace(/ /g, '_')), snippet: page.extract,
    }));
  const results = uniqueResults([...indexed, ...encyclopedia], domains);
  const provider = results.some(result => result.domain === wikiHost)
    ? (results.some(result => result.domain !== wikiHost) ? 'Bing Web RSS + Wikipedia' : 'Wikipedia')
    : 'Bing Web RSS';
  return {results, provider};
}

export function createSearch({fetchImpl = fetch, now = Date.now} = {}) {
  const cache = new Map();
  let inflight = 0;
  return async function search(raw, {signal, config} = {}) {
    signal?.throwIfAborted();
    const query = normalizeSearchQuery(raw, config?.apiKey);
    const domains = [...query.matchAll(SITE)].map(match => match[1].toLowerCase().replace(/\.$/, ''));
    const preferred = nativeProvider(config);
    const key = JSON.stringify([preferred, preferred ? config.model : '', query]);
    const cached = cache.get(key);
    if (cached && now() - cached.time < CACHE_MS) return {...cached.value, cached: true};
    if (inflight >= 8) throw new Error('检索繁忙，请稍后重试。');
    inflight++;
    try {
      let provider = preferred;
      let results = [];
      if (preferred) {
        const sources = await nativeSearch(fetchImpl, preferred, config, query, domains, withTimeout(signal, 14_000)).catch(() => []);
        results = uniqueResults(sources, domains);
      }
      signal?.throwIfAborted();
      if (!results.length) ({results, provider} = await publicSearch(fetchImpl, query, domains, withTimeout(signal, 8500)));
      signal?.throwIfAborted();
      if (!results.length) throw new Error('未找到符合关键词的公开来源。');
      const time = now();
      const value = {query, provider, retrievedAt: new Date(time).toISOString(), results};
      cache.set(key, {time, value});
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    } finally {
      inflight--;
    }
  };
}
