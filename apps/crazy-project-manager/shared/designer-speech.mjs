const entities = new Map([['amp', '&'], ['lt', '<'], ['gt', '>']]);
const syntax = new Set(['&', '<', '>', '{', '}', '[', ']', '`']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeMarkup(value) {
  let source = value;
  for (let pass = 0; pass < 3; pass++) {
    const decoded = source.replace(/&(amp|lt|gt|#x[0-9a-f]{1,6}|#[0-9]{1,7});/gi, (match, entity) => {
      const key = entity.toLowerCase();
      if (entities.has(key)) return entities.get(key);
      const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      const character = String.fromCharCode(code);
      return code <= 127 && syntax.has(character) ? character : match;
    }).replace(/\\+(?:u00|x)([0-9a-f]{2})/gi, (match, hex) => {
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return syntax.has(character) ? character : match;
    });
    if (decoded === source) break;
    source = decoded;
  }
  if (/%3c(?:%2f|\/)?(?:svg|html|xml|path|rect|g|\?|%3f)(?:%|[\s/>])/i.test(source)) {
    source = source.replace(/%([0-9a-f]{2})/gi, (match, hex) => {
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return syntax.has(character) || /[\s/?!]/.test(character) ? character : match;
    });
  }
  return source;
}

function through(source, delimiter, start) {
  const index = source.indexOf(delimiter, start);
  return index < 0 ? source.length : index + delimiter.length;
}

function tagEnd(source, start, declaration) {
  let quote, brackets = 0;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (declaration && character === '[') brackets++;
    else if (declaration && character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === '>' && !brackets) return index + 1;
  }
  return source.length;
}

function markup(source, start) {
  if (source.startsWith('<!--', start)) return { end: through(source, '-->', start + 4) };
  if (source.startsWith('<![CDATA[', start)) return { end: through(source, ']]>', start + 9) };
  if (source.startsWith('<?', start)) return { end: through(source, '?>', start + 2) };
  if (source.startsWith('<!', start)) return { end: tagEnd(source, start + 2, true) };

  const header = /<(\/?)([a-z_][\w:.-]*)(?=[\s/>]|$)/iy;
  header.lastIndex = start;
  const match = header.exec(source);
  if (!match) return null;
  const end = tagEnd(source, header.lastIndex);
  const name = match[2].toLowerCase();
  return { name, end, closing: match[1] === '/', single: voidTags.has(name) || /\/\s*>$/.test(source.slice(header.lastIndex, end)) };
}

function markupEnd(source, start) {
  const root = markup(source, start);
  if (!root || !root.name || root.closing || root.single) return root?.end;
  let depth = 1;
  let position = root.end;
  while ((position = source.indexOf('<', position)) >= 0) {
    const token = markup(source, position++);
    if (!token) continue;
    position = token.end;
    if (token.name !== root.name || token.single) continue;
    if (token.closing) depth--;
    else depth++;
    if (depth === 0) return position;
  }
  return source.length;
}

function structuredEnd(source, start) {
  const pending = [];
  let quote;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{' || character === '[') pending.push(character === '{' ? '}' : ']');
    else if (character === '}' || character === ']') {
      if (character !== pending.pop()) break;
      if (!pending.length) return index + 1;
    }
  }
  return source.length;
}

function fenceEnd(source, fence, start) {
  let end = through(source, fence, start + fence.length);
  while (source[end] === fence[0]) end++;
  return end;
}

function cleanSpeech(fragment) {
  const line = fragment.replace(/&(?:quot|#34|#x22);/gi, '"').replace(/&(?:apos|#39|#x27);/gi, "'")
    .trim().replace(/^[\s"'`;(),，：:]+/, '').trim();
  if (!/\p{L}/u.test(line)) return '';
  if (/\b[\w:-]+\s*=\s*["']|\b(?:xmlns(?::\w+)?|viewBox|width|height|stroke(?:-[\w-]+)?|fill|transform|font-(?:size|family)|points|opacity|href|id|d|[xy][12]?|c[xy]|r[xy]?)\s*=/i.test(line)) return '';
  if (/^["']?(?:tools?|tool_calls?|arguments|parameters|operations|commands|parts|speech|reply|svg|xml|html|json|style|fill|stroke|[xywhd])["']?\s*[:=]/i.test(line)) return '';
  if (/^(?:(?:const|let|var)\s+[$\w]+\s*[=;]|function\s+[$\w]+\s*\(|import\b[^\n]*\bfrom\b|export\s+(?:default|const|function)\b|(?:document|window)\.[\w.]+\s*\()/i.test(line)) return '';
  if (/^(?:(?:run_canvas|edit_poster|edit_text|draw_vector|submit_draft|preview_draft)\b|[.#][\w-]+\s*$)/i.test(line)) return '';
  if (/^[Mm]\s*-?(?:\d|\.\d)(?:[\d\s.,+\-eE]|[MmLlHhVvCcSsQqTtAaZz])+$/u.test(line)) return '';
  if (/(?:^|\s)(?:svg|xml|html|json|source code|代码|工具参数)\s*[:：]\s*$/i.test(line)) return '';
  return line;
}

export function designerSpeech(value) {
  if (typeof value !== 'string') return '';
  const source = decodeMarkup(value);
  const marker = /data:(?:image|application|text)\/[^\s"'<>]+|<|`+|~{3,}|[\[{]/gi;
  const spoken = [];
  let start = 0;
  for (let token; (token = marker.exec(source));) {
    const first = token[0][0];
    let end = marker.lastIndex;
    if (first === '<') end = markupEnd(source, token.index);
    else if (first === '{' || first === '[') end = structuredEnd(source, token.index);
    else if (first === '`' || first === '~') end = fenceEnd(source, token[0], token.index);
    if (end === undefined) continue;
    spoken.push(source.slice(start, token.index));
    start = marker.lastIndex = end;
  }
  spoken.push(source.slice(start));
  return spoken.flatMap(fragment => fragment.split(/\r?\n/u)).map(cleanSpeech).filter(Boolean).join(' ');
}
