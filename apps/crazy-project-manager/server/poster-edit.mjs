import { getElement, palettes, projectTitle, theme } from './poster.mjs';
import { estimatedTextWidth } from './poster-review.mjs';
import { localInstruction } from './role-language.mjs';
import { isBuiltInElement, nextElementId } from './design-tools.mjs';

export { localInstruction as normalizeEditInstruction } from './role-language.mjs';

const aliases = {
  title: /(?:主标题|大标题|标题|展名|活动名)/i,
  logo: /(?:馆标|白标|旧标|品牌标(?:识|志)?|标志|logo)/i,
  sticker: /(?:黄贴|贴纸|角标|免费[^，。；]{0,8}(?:预约|入场)|预约提示|预约条件|免费(?:这|两|和|与|·)?)/i,
  qr: /(?:预约(?:二维码|码|链接|入口)|二维码|报名码|二维码链接|报名入口)/i,
  credits: /(?:署名|联合主办|合作方全称)/i,
  info: /(?:信息区|底部信息|活动信息|展期|日期|时段|时间|东门|西门|南门|北门|入场|馆址|地点)/i,
  visual: /(?:主视觉|主图|图片|环形图|视觉素材)/i,
  palette: /(?:配色|色调|颜色|荧光绿|夜紫|紫色|蓝金|金色|深绿|蓝色)/i,
  tagline: /(?:宣传语|副标题|口号|标语)/i,
};

const changeWords = /(?:放大|缩小|大一[点些]|小一[点些]|加大|做成|添上|改|换|移|挪|放|还原|恢复|收小|整理|凸显|缩回|突出|醒目|字号|看清|遮挡|露出来|读到|记住|显示|擦掉|删除|调|分[两三]行|断行|去掉|靠|改写)/;
const sizesUp = /(?:放大|加大|大一[点些]|更大|加粗|醒目|凸显|突出|显眼|记住|看清|读到)/;
const sizesDown = /(?:缩小|小一[点些]|更小|缩回|收小)/;
const initialClarification = '你要我动标题、主图，还是颜色？说一处，我马上改。';

function parseClauses(text) {
  const parts = text.match(/(?:「[^」]*」|“[^”]*”|《[^》]*》|"[^"]*"|(?<=\d)[，,](?=\s*\d)|[^，。；！？,;、\n])+/g);
  return (parts ?? []).map(part => part.trim()).filter(Boolean);
}

function exactText(text) {
  const match = text.match(/(?:写成|改成|改为|换成|替换为|重写为|文字用)\s*[「“《"]([^」”》"]+)[」”》"]/);
  return match?.[1];
}

function requestedSize(text) {
  const match = text.match(/(?:字号|尺寸|边长|放大到|缩小到)\s*(?:改成|调到|设置为|改为|为|到)?\s*(\d{1,3})(?:\s*(?:px|像素|号))?/i);
  return match ? Number(match[1]) : undefined;
}

function geometry(text, layer, positions = {}) {
  const match = text.match(/(?:移到|挪到|放到)\s*[（(]?\s*(\d+(?:\.\d+)?)\s*[,，]\s*(\d+(?:\.\d+)?)/);
  if (match) return { x: Number(match[1]), y: Number(match[2]) };
  if (!/(?:移|挪|放|摆|换到|在)/.test(text)) return {};
  if (/右上/.test(text)) return positions.topRight ?? { x: 562 - layer.w, y: 27 };
  if (/左上/.test(text)) return positions.topLeft ?? { x: 36, y: 28 };
  if (/左下/.test(text)) return positions.bottomLeft ?? { x: 36, y: 765 - layer.h };
  if (/右下/.test(text)) return positions.bottomRight ?? { x: 562 - layer.w, y: 765 - layer.h };
  if (/(?:正中|中间|居中)/.test(text)) return { x: (theme.width - layer.w) / 2, y: (theme.height - layer.h) / 2 };
  return {};
}

function matchTargets(text, scene) {
  const targets = Object.entries(aliases).flatMap(([id, expression]) => {
    const match = expression.exec(text);
    return match ? [{ id, index: match.index }] : [];
  });
  if (scene) for (const layer of scene.elements) {
    if (isBuiltInElement(layer.id)) continue;
    const position = text.toLowerCase().indexOf(layer.id);
    const label = layer.label ? text.indexOf(layer.label) : -1;
    if (position >= 0 || label >= 0) targets.push({ id: layer.id, index: position >= 0 ? position : label });
  }
  return targets.sort((first, second) => first.index - second.index);
}

function impliedTarget(text, previous) {
  if (/(?:调大|调小|再大|再小|缩小|放大|挪到|移到|换成|改成|放到|删掉|去掉|显示|缩回|往下|字距|字间距|行高|行距|字号|左右对齐|左对齐|右对齐|居中|大写|斜体|字体|颜色|填充|描边|旋转|透明度|圆角|font|spacing|align|opacity|rotate|stroke|fill)/i.test(text)) return previous;
  return undefined;
}

function updateSize(text, layer, adjustment) {
  if (requestedSize(text) !== undefined) return requestedSize(text);
  if (sizesUp.test(text)) return Math.min(adjustment.max, layer.size + adjustment.by);
  if (sizesDown.test(text)) return Math.max(adjustment.min, layer.size - adjustment.by);
  return layer.size;
}

function updateTitle(text, layer, scene) {
  const original = /还原|恢复(?:原|初)/.test(text);
  const originalTitle = scene.project && /还原|恢复(?:原|初)|分两行/.test(text)
    ? projectTitle(scene.project.name) : null;
  const size = original ? originalTitle?.size ?? 100 : updateSize(text, layer, { min: 30, max: 145, by: 10 });
  let content = exactText(text) ?? layer.text;
  if (original || /分两行|夜游在上/.test(text)) content = originalTitle?.text ?? (scene.project ? content : '夜游\n美术馆');
  if (/改为一行|并成一行|单行/.test(text)) content = content.replaceAll('\n', '');
  const weight = /加粗|加重/.test(text) ? 800 : /变细|细一[点些]/.test(text) ? 400 : layer.weight;
  const lines = content.split('\n');
  const width = Math.max(layer.w, Math.ceil(Math.max(...lines.map(line => estimatedTextWidth(line, size))) + 3));
  const height = Math.max(layer.h, Math.ceil(size * (1 + 1.08 * (lines.length - 1))));
  const position = geometry(text, { ...layer, w: width, h: height }, { topLeft: { x: 35, y: 82 } });
  const x = position.x ?? layer.x;
  const y = position.y ?? layer.y;
  return { ...position, size, text: content, weight, w: Math.min(theme.width - x, width), h: Math.min(theme.height - y, height) };
}

function updateSticker(text, layer) {
  const content = exactText(text) ?? layer.text;
  if (/(?:还原|恢复)(?:小贴|原样|原来|初始)/.test(text)) return { x: 342, y: 735, w: 107, h: 23, size: 12, text: content, treatment: 'plain' };
  const bottom = /(?:底部|预约(?:码|区|入口)旁|报名(?:码|区)旁|码旁边|底栏|脚注|下方|移开|放在一起|放一起|不挡|让开)/.test(text);
  const dramatic = /(?:大黄贴|黄贴放大|大号|标题旁|展名旁|顶上|顶部|遮住半个馆标)/.test(text);
  if (bottom && changeWords.test(text)) return { x: 312, y: 687, w: 143, h: 58, size: 21, text: content, treatment: 'callout', hidden: false };
  if (dramatic && changeWords.test(text)) return { x: 323, y: 43, w: 190, h: 108, size: 35, text: content, treatment: 'yellow', hidden: false };
  if (sizesUp.test(text) && layer.treatment === 'plain') return { x: 312, y: 687, w: 143, h: 58, size: 21, text: content, treatment: 'callout', hidden: false };
  const position = geometry(text, layer);
  return { ...position, text: content, size: updateSize(text, layer, { min: 8, max: 48, by: 3 }) };
}

function updateLogo(text, layer) {
  const old = /(?:用|换成|使用|恢复|试)\s*(?:旧馆标|旧标|旧版馆标)/.test(text);
  const approved = /(?:白标|授权|正式|规范)/.test(text) && !/(?:不要|别用)\s*白标/.test(text);
  const width = requestedSize(text) ?? (sizesUp.test(text) ? 154 : sizesDown.test(text) ? 112 : layer.w);
  const height = layer.h * width / layer.w;
  const position = geometry(text, { ...layer, w: width, h: height }, { topRight: { x: 562 - width, y: 25 }, bottomLeft: { x: 36, y: 666 - height } });
  return { ...position, asset: old ? theme.assets.oldLogo : approved ? theme.assets.approvedLogo : layer.asset, w: width, h: height };
}

function updateInfo(text, layer, scene) {
  const facts = scene.project?.facts ?? theme.facts;
  const gate = text.match(/(?:改成|改为|改走|换成|走|使用|从|写)\s*([东南西北]门)(?:入场)?/);
  const hours = text.match(/(\d{1,2}:\d{2})\s*[-—–~～至到]\s*(\d{1,2}:\d{2})/);
  const date = text.match(/(\d{1,2}[./]\d{1,2})\s*[-—–~～至到]\s*(\d{1,2}[./]\d{1,2})/);
  const venue = /(?:地点|馆址|馆名).*(?:改|写|换)/.test(text) ? exactText(text) : undefined;
  const time = /(?:日期|展期|时间).*(?:改|写|换)/.test(text) ? exactText(text) : undefined;
  const reset = /整理|按简报|恢复|重排|保全/.test(text);
  let size = updateSize(text, layer, { min: 9, max: 28, by: 2 });
  if (/整理|重排/.test(text)) size = 19;
  return {
    ...geometry(text, layer),
    gate: gate ? `${gate[1]}入场` : reset ? facts.gate : layer.gate,
    date: time ?? (date ? `${date[1]} — ${date[2]}` : reset ? facts.date : layer.date),
    hours: hours ? `${hours[1]} — ${hours[2]}` : reset ? facts.hours : layer.hours,
    venue: venue ?? (reset ? facts.venue : layer.venue),
    size,
  };
}

function updateQR(text, layer, scene) {
  const requested = requestedSize(text);
  const delta = requested === undefined ? sizesUp.test(text) ? 14 : sizesDown.test(text) ? -28 : 0 : requested - layer.w;
  const w = layer.w + delta;
  const h = layer.h + delta;
  const url = exactText(text) ?? (/(?:复核|恢复|正确|测试|原来)/.test(text) ? scene.reservationUrl : layer.url);
  const rightBound = Math.min(layer.x, theme.width - w - 16);
  const bottomBound = Math.min(layer.y, theme.height - h - 19);
  return { x: rightBound, y: bottomBound, ...geometry(text, { ...layer, w, h }), w, h, url };
}

function updatePalette(text, layer, scene) {
  if (/深绿|荧光绿|绿色/.test(text)) return { preset: 'green' };
  if (/夜紫|紫色|紫调/.test(text)) return { preset: 'purple' };
  if (/蓝金|蓝色|金色|暖金/.test(text)) return { preset: 'blue' };
  if (/还原|恢复/.test(text)) return { preset: scene.project ? 'purple' : 'green' };
  const entries = Object.keys(palettes);
  return { preset: entries[(entries.indexOf(layer.preset) + 1) % entries.length] };
}

function updateText(text, layer, scene) {
  const facts = scene.project?.facts ?? theme.facts;
  return { ...geometry(text, layer), text: exactText(text) ?? (layer.id === 'credits' && /完整|补齐|恢复|按简报/.test(text) ? facts.credits : layer.text), size: updateSize(text, layer, { min: 8, max: 36, by: 2 }) };
}

function updateVisual(text, layer) {
  if (/恢复|环形|初稿|原来/.test(text)) return { asset: theme.assets.mainVisual, hidden: false };
  return geometry(text, layer);
}

const editors = {
  title: updateTitle, logo: updateLogo, sticker: updateSticker, info: updateInfo,
  qr: updateQR, palette: updatePalette, credits: updateText, tagline: updateText, visual: updateVisual,
};

function heldLayers(text, scene) {
  return new Set(parseClauses(text).flatMap(clause => {
    if (!/(?:别|不要|不许|不能|不用|不必)\s*(?:更改|改|动|碰|换|删)|保持.{0,9}(?:不变|原样)/.test(clause)) return [];
    return matchTargets(clause, scene).slice(0, 1).map(target => target.id);
  }));
}

function fallbackInstruction(text, messages) {
  const instruction = message => message.requirement?.instruction || message.text || '';
  if (!text || /^(?:合并|采纳|同意|按|照着|照).{0,12}(?:意见|建议|原话|他说的|她说的)[吧。！!]*$/.test(text)) {
    return messages.map(instruction).filter(Boolean).join('；');
  }
  if (messages.length === 1 && messages[0].text === text) return messages[0].requirement?.instruction || text;
  return text;
}

function editLabels(patches, scene) {
  if (!scene.project && patches.length === 1 && patches[0].id === 'sticker') {
    if (patches[0].set?.treatment === 'yellow') return ['放大标题旁的黄贴', '免费和须预约已经做成标题旁的大黄贴。'];
    if (patches[0].set?.treatment === 'callout') return ['黄贴移至预约区', '黄贴挪到预约码旁边了。免费、须预约都在这块。'];
  }
  const layers = patches.map(patch => patch.element?.label ?? getElement(scene, patch.id).label).join('、');
  return [`调整${layers}`, `${layers}改好了。你看这版。`];
}

function layerStyle(text) {
  const style = {};
  if (/(?:等宽|monospace|mono\b)/i.test(text)) style.fontFamily = 'mono';
  else if (/(?:无衬线|黑体|sans(?:-serif)?\b)/i.test(text)) style.fontFamily = 'sans';
  else if (/(?:宋体|衬线|\bserif\b)/i.test(text)) style.fontFamily = 'serif';
  if (/(?:居中|中间对齐|center(?:ed)?(?:\s+align)?\b)/i.test(text) && !/(?:放到|移到|挪到|位置|坐标|\bmove\b)/i.test(text)) style.textAlign = 'center';
  else if (/(?:右对齐|right[- ]align)/i.test(text)) style.textAlign = 'right';
  else if (/(?:左对齐|left[- ]align)/i.test(text)) style.textAlign = 'left';
  if (/(?:斜体|italic)/i.test(text)) style.fontStyle = 'italic';
  if (/(?:加粗|\bbold\b)/i.test(text)) style.fontWeight = 800;
  if (/(?:字重|font\s*weight)[^\d]{0,8}(\d{3})/i.test(text)) style.fontWeight = Number(text.match(/(?:字重|font\s*weight)[^\d]{0,8}(\d{3})/i)[1]);
  if (/(?:下划线|underline)/i.test(text)) style.textDecoration = 'underline';
  const measures = {
    fontSize: /(?:字号|font\s*size)[^\d]{0,7}(\d+(?:\.\d+)?)/i,
    letterSpacing: /(?:字间距|字距|tracking|letter[\s-]*spacing)[^\d+\-]{0,8}([+\-]?\d+(?:\.\d+)?)/i,
    lineHeight: /(?:行高|行距|line[\s-]*height)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(%)?/i,
    opacity: /(?:透明度|opacity)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(%)?/i,
    strokeWidth: /(?:描边宽度|线宽|stroke[\s-]*width)[^\d]{0,8}(\d+(?:\.\d+)?)/i,
    rotation: /(?:旋转|rotate)[^\d+\-]{0,8}([+\-]?\d+(?:\.\d+)?)/i,
    radius: /(?:圆角|corner\s+radius)[^\d]{0,8}(\d+(?:\.\d+)?)/i,
  };
  for (const [key, pattern] of Object.entries(measures)) {
    const match = pattern.exec(text);
    if (match) style[key] = Number(match[1]) / (match[2] ? 100 : 1);
  }
  const hex = text.match(/#[a-f\d]{8}\b|#[a-f\d]{6}\b|#[a-f\d]{3,4}\b/i)?.[0];
  const named = Object.entries({ 红色: 'red', 蓝色: 'blue', 绿色: 'green', 黄色: 'yellow', 紫色: 'purple', 粉色: 'pink', 白色: 'white', 黑色: 'black', 橙色: 'orange' })
    .find(([name]) => text.includes(name))?.[1] ?? text.match(/\b(red|blue|green|yellow|purple|white|black|orange|pink|gray|gold)\b/i)?.[0]?.toLowerCase();
  if (hex || named) style[/(?:描边|边框|stroke)/i.test(text) && !/(?:填充|底色|fill)/i.test(text) ? 'stroke' : 'fill'] = hex ?? named;
  return style;
}

function newLayerBox(text, scene, defaultSize) {
  const dimensions = text.match(/(?:尺寸|大小|size)?\s*(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)(?:\s*(?:px|像素))?/i);
  const w = dimensions ? Number(dimensions[1]) : defaultSize[0];
  const h = dimensions ? Number(dimensions[2]) : defaultSize[1];
  const point = text.match(/(?:坐标|放在|放到|位置|位置在|\bat\b|\bposition\b)\s*[(（]?\s*(\d+(?:\.\d+)?)\s*[,，]\s*(\d+(?:\.\d+)?)/i);
  const left = /(?:左上|左下|upper[- ]left|lower[- ]left|top[- ]left|bottom[- ]left)/i.test(text);
  const right = /(?:右上|右下|upper[- ]right|lower[- ]right|top[- ]right|bottom[- ]right)/i.test(text);
  const top = /(?:左上|右上|upper|top)/i.test(text);
  const bottom = /(?:左下|右下|lower|bottom)/i.test(text);
  return {
    w, h,
    x: point ? Number(point[1]) : left ? 30 : right ? scene.width - w - 30 : (scene.width - w) / 2,
    y: point ? Number(point[2]) : top ? 30 : bottom ? scene.height - h - 30 : (scene.height - h) / 2,
  };
}

function newLayer(text, scene, context) {
  if (!/(?:新增|新建|添加|插入|画个|画一个|加上一个|加一[个条行张块]|加个|绘制|导入|\b(?:add|create|draw|insert|place|import)\b)/i.test(text)) return null;
  const style = layerStyle(text);
  const quoted = text.match(/[「“"]([^」”"]+)[」”"]/u)?.[1];
  const shape = !/\bline of text\b/i.test(text) && [
    ['ellipse', /椭圆|圆形|画圆|\bcircle\b|\bellipse\b/i], ['rect', /矩形|长方形|方框|方形|\brect(?:angle)?\b|\bsquare\b/i],
    ['star', /星形|五角星|\bstar\b/i], ['triangle', /三角形|\btriangle\b/i], ['line', /线段|分隔线|直线|\bline\b/i],
  ].find(([, pattern]) => pattern.test(text))?.[0];
  const wantsImage = /(?:素材|外部图片|插图|照片|图片|\bimage\b|\bphoto\b|\basset\b)/i.test(text);
  const wantsText = /(?:文字|文本|标题|标语|\btext\b|\bcaption\b)/i.test(text);
  if (!shape && !wantsImage && !wantsText) return null;
  let element;
  if (wantsImage && !shape) {
    const materialList = context.assets ?? context.materials;
    const assets = Array.isArray(materialList) ? materialList : [];
    const asset = assets.find(item => [item.name, item.id, item.hash].some(value => typeof value === 'string' && value && text.includes(value))) ?? (assets.length === 1 ? assets[0] : null);
    const hash = asset?.hash ?? asset?.id;
    if (!/^[a-f0-9]{64}$/.test(hash ?? '')) return { clarification: '请先把图片导入本项目的素材库，再告诉我放哪一张。', elementIds: [] };
    element = { type: 'image', label: asset.name ?? '导入图片', image: `studio-asset:${hash}`, fit: 'contain', ...newLayerBox(text, scene, [180, 140]) };
  } else if (shape) {
    const names = { rect: '矩形', ellipse: '圆形', star: '星形', triangle: '三角形', line: '分隔线' };
    if (shape === 'line' && style.fill && !style.stroke) style.stroke = style.fill;
    element = { type: 'shape', shape, label: names[shape], ...newLayerBox(text, scene, shape === 'line' ? [160, 16] : [120, 80]) };
  } else {
    if (!quoted) return { clarification: '新增文字时，请用引号标出要写在海报上的内容。', elementIds: [] };
    element = { type: 'text', label: Array.from(quoted.replace(/\s+/g, ' ')).slice(0, 26).join(''), text: quoted, ...newLayerBox(text, scene, [280, 96]) };
  }
  element.id = nextElementId(scene, element.type);
  if (Object.keys(style).length) element.style = style;
  return element;
}

export function planEdit(input, scene, context = {}) {
  const text = localInstruction(fallbackInstruction(String(input ?? '').trim(), (context.sourceMessages ?? []).filter(Boolean)));
  const addition = newLayer(text, scene, context);
  if (addition?.clarification) return addition;
  if (addition) return { label: `添加${addition.label}`, patches: [{ op: 'add', element: addition }], elementIds: [addition.id], reply: `${addition.label}改好了。你看这版。` };
  const held = heldLayers(text, scene);
  const edits = new Map();
  const operations = new Map();
  let previous;
  for (const clause of parseClauses(text)) {
    const target = matchTargets(clause, scene)[0]?.id ?? impliedTarget(clause, previous);
    if (!target || held.has(target)) continue;
    previous = target;
    const active = { ...getElement(scene, target), ...edits.get(target) };
    const hide = /(?:去掉|删除|删掉|隐藏|撤掉|摘掉|擦掉|拿掉)/.test(clause);
    const show = /(?:露出来|显示|恢复)/.test(clause);
    if (!isBuiltInElement(target) && /(?:删除|删掉|remove\b|delete\b)/i.test(clause)) {
      operations.set(target, { op: 'delete', id: target });
      edits.delete(target);
      continue;
    }
    if (operations.get(target)?.op === 'delete') continue;
    if (target !== 'palette' && /(?:移到最上层|置顶|放到最前|bring to front)/i.test(clause)) operations.set(target, { op: 'reorder', id: target, index: scene.elements.length - 1 });
    else if (target !== 'palette' && /(?:移到最下层|置底|send to back)/i.test(clause)) operations.set(target, { op: 'reorder', id: target, index: 1 });
    const style = layerStyle(clause);
    const explicit = Object.keys(style).length > 0 && (target !== 'palette' || /(?:填充|底色|#)/.test(clause));
    const fallback = { ...geometry(clause, active) };
    if (active.type === 'text' && exactText(clause)) fallback.text = exactText(clause);
    const operation = hide ? {} : explicit && !exactText(clause) ? fallback : editors[target]?.(clause, active, scene) ?? fallback;
    if (!hide && !show && !explicit && !changeWords.test(clause) && !exactText(clause) && target !== 'palette') continue;
    if (hide || show) operation.hidden = hide;
    if (explicit) operation.style = { ...active.style, ...style };
    edits.set(target, { ...edits.get(target), ...operation });
  }

  const patches = [];
  for (const [id, updated] of edits) {
    const layer = getElement(scene, id);
    const set = Object.fromEntries(Object.entries(updated).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(layer[key]) && !(key === 'hidden' && !value && layer[key] === undefined)));
    if (Object.keys(set).length) patches.push({ id, set });
  }
  patches.push(...operations.values());
  if (!patches.length) {
    const targets = [...new Set(matchTargets(text, scene).map(match => match.id))];
    const clarification = /高级|有感觉|更好看|几个卖点|联名那份/.test(text)
      ? initialClarification
      : targets.length ? `我先确认一下，「${getElement(scene, targets[0]).label}」要改内容、大小，还是位置？` : initialClarification;
    return { clarification, elementIds: targets };
  }
  const [label, reply] = editLabels(patches, scene);
  return { label, patches, elementIds: patches.map(patch => patch.id), reply };
}
