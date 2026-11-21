import { maxVectorCoordinate, normalizeVectorPath } from './vector-path.mjs';
import { posterFontChoices, posterFontIds, posterFonts } from './poster-fonts.mjs';
import { paperUnitsPerMm, posterPaper, posterPaperLimits } from './poster-paper.mjs';

const layerId = /^[a-z][a-z0-9_-]{0,47}$/;
const assetReference = /^studio-asset:[a-f0-9]{64}$/;
const geometricFields = ['x', 'y', 'w', 'h', 'hidden', 'group'];
const sharedFields = [...geometricFields, 'label', 'style', 'gradient', 'mask'];
const builtInFields = {
  palette: ['preset', 'decorations', 'style', 'gradient', 'mask'],
  visual: ['asset', 'image', 'imageName', 'fit'],
  title: ['text', 'size', 'weight'],
  tagline: ['text', 'size'],
  logo: ['asset'],
  info: ['date', 'hours', 'venue', 'gate', 'size'],
  credits: ['text', 'size'],
  qr: ['url'],
  sticker: ['text', 'size', 'treatment'],
};
const customFields = {
  text: ['text'],
  shape: ['shape', 'points', 'd', 'viewWidth', 'viewHeight'],
  vector: ['parts', 'partChanges', 'viewWidth', 'viewHeight'],
  image: ['image', 'fit'],
};
const vectorPartFields = {
  path: ['d'], line: ['points'], polyline: ['points'], polygon: ['points'],
  rect: ['x', 'y', 'w', 'h'], ellipse: ['x', 'y', 'w', 'h'],
};
const vectorPartStyle = ['fill', 'fillOpacity', 'fillRule', 'stroke', 'strokeOpacity', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'opacity', 'radius'];
const maskPartStyle = ['opacity', 'radius', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fillRule'];
const maxVectorParts = 32;
const shapeNames = new Set(['rect', 'ellipse', 'line', 'polygon', 'polyline', 'path', 'triangle', 'star']);
const fitModes = new Set(['contain', 'cover', 'fill']);
const colors = new Set(['none', 'transparent', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'gold', 'cyan', 'navy', 'teal', 'brown', 'lime', 'maroon', 'olive', 'silver', 'magenta']);
const ranges = {
  opacity: [0, 1], fillOpacity: [0, 1], strokeOpacity: [0, 1], strokeWidth: [0, 100],
  fontSize: [6, 200], fontWeight: [100, 900], letterSpacing: [-20, 100], lineHeight: [.5, 4],
  radius: [0, 500], rotation: [-360, 360],
};
export const layerBlendModes = Object.freeze([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'hard-light', 'soft-light', 'difference', 'exclusion',
]);
const choices = {
  blendMode: new Set(layerBlendModes),
  textAlign: new Set(['left', 'center', 'right']),
  verticalAlign: new Set(['top', 'middle', 'bottom']),
  fontStyle: new Set(['normal', 'italic']),
  textDecoration: new Set(['none', 'underline', 'line-through']),
  textTransform: new Set(['none', 'uppercase', 'lowercase', 'capitalize']),
  strokeLinecap: new Set(['butt', 'round', 'square']),
  strokeLinejoin: new Set(['miter', 'round', 'bevel']),
  fillRule: new Set(['nonzero', 'evenodd']),
};
const fontAliases = new Map(Object.entries({
  sans: ['sans', 'sans-serif', 'sans serif', 'system-ui', 'ui-sans-serif', 'arial', 'arial black', 'helvetica', 'helvetica neue',
    'inter', 'roboto', 'verdana', 'tahoma', 'montserrat', 'poppins', 'open sans', 'segoe ui', 'calibri', 'aptos', 'futura', 'avenir', 'avenir next',
    '-apple-system', 'blinkmacsystemfont',
    'noto sans', 'noto sans sc', 'noto sans cjk sc', 'source han sans sc', 'microsoft yahei', 'simhei', 'museum poster', 'museumposter', '微软雅黑', '黑体'],
  serif: ['serif', 'ui-serif', 'times', 'times new roman', 'georgia', 'garamond', 'baskerville', 'playfair display', 'libre baskerville',
    'noto serif', 'noto serif sc', 'noto serif cjk sc', 'source han serif sc', 'simsun', 'museum serif', 'museumserif', '宋体'],
  mono: ['mono', 'monospace', 'monospaced', 'ui-monospace', 'courier', 'courier new', 'consolas', 'menlo', 'monaco', 'sfmono-regular',
    'lucida console', 'ibm plex mono', 'jetbrains mono', 'fira code', 'noto sans mono', 'museummono'],
}).flatMap(([family, aliases]) => aliases.map(alias => [alias, family])));
for (const [id, font] of Object.entries(posterFonts)) {
  fontAliases.set(id, id);
  fontAliases.set(font.name.toLowerCase(), id);
  for (const alias of font.aliases ?? []) fontAliases.set(alias.toLowerCase(), id);
}

const colorFields = ['fill', 'stroke', 'textColor'];
const styleFields = [...colorFields, ...Object.keys(ranges), 'fontFamily', ...Object.keys(choices)];

function styleSchema(fields) {
  const properties = Object.fromEntries(fields.map(key => {
    if (key === 'fontFamily') return [key, { type: ['string', 'null'],
      description: `Font ID: ${posterFontChoices}. Unsupported glyphs use the bundled font fallback. Common CSS family aliases are accepted.` }];
    if (key === 'blendMode') return [key, { type: ['string', 'null'], enum: [...layerBlendModes, null],
      description: 'Blend this whole layer with layers already drawn below it. Use normal or null to restore the default.' }];
    if (Object.hasOwn(ranges, key)) {
      const [minimum, maximum] = ranges[key];
      return [key, { type: ['number', 'null'], minimum, maximum }];
    }
    if (Object.hasOwn(choices, key)) return [key, { type: ['string', 'null'], enum: [...choices[key], null] }];
    return [key, { type: ['string', 'null'], description: 'Hex or basic named color, none, or transparent.' }];
  }));
  return { type: ['object', 'null'], properties, additionalProperties: false };
}

export const designStyleSchema = styleSchema(styleFields);

export function vectorPartSchema({ mask = false } = {}) {
  const point = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } };
  const coordinate = { type: 'number' };
  return {
    type: 'object', required: ['id', 'shape'],
    properties: { id: { type: 'string' }, shape: { type: 'string' }, style: styleSchema(mask ? maskPartStyle : vectorPartStyle) },
    oneOf: Object.entries(vectorPartFields).map(([shape, fields]) => ({
      type: 'object', additionalProperties: false, required: ['shape', ...fields],
      properties: {
        id: {}, shape: { enum: [shape] }, style: {},
        ...Object.fromEntries(fields.map(field => [field, field === 'd' ? { type: 'string', description: 'SVG path commands in layer-local coordinates.' }
          : field === 'points' ? { type: 'array', items: point, minItems: shape === 'polygon' ? 3 : 2, maxItems: shape === 'line' ? 2 : 160 } : coordinate])),
      },
    })),
  };
}

export const isBuiltInElement = id => typeof id === 'string' && Object.hasOwn(builtInFields, id);
export const isAssetReference = value => typeof value === 'string' && assetReference.test(value);

function record(value) {
  return value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertKeys(value, keys) {
  if (!record(value)) throw new Error('图层操作须使用结构化字段。');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`图层操作不支持字段 ${key}。`);
}

function assertId(id) {
  if (typeof id !== 'string' || !layerId.test(id)) throw new Error('图层 ID 须以小写英文字母开头，只能使用小写字母、数字、连字符和下划线。');
  return id;
}

function fontFamily(value) {
  const error = () => new Error(`fontFamily 支持 ${posterFontIds.join('、')}，也可使用字体原名或常见 CSS 字体名。`);
  if (typeof value !== 'string' || value.length > 200) throw error();
  const names = value.split(',').map(name => name.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase().replace(/\s+/g, ' '));
  if (names.some(name => !fontAliases.has(name) && !/^[\p{L}\p{N}_ -]{1,60}$/u.test(name))) throw error();
  const family = names.map(name => fontAliases.get(name)).find(Boolean);
  if (!family) throw error();
  return family;
}

export function nextElementId(scene, prefix = 'layer') {
  const used = new Set(scene.elements.map(element => element.id));
  const base = String(prefix).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 39) || 'layer';
  for (let suffix = 1; suffix <= used.size + 1; suffix++) {
    const id = `${base}-${suffix}`;
    if (!used.has(id) && !isBuiltInElement(id)) return id;
  }
  throw new Error('当前海报无法分配更多图层。');
}

export function normalizeDesignStyle(value) {
  if (value === null) return null;
  const result = {};
  assertKeys(value, styleFields);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) result[key] = null;
    else if (colorFields.includes(key)) {
      const color = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (!/^(?:#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8})$/.test(color) && !colors.has(color)) throw new Error(`「${key}」须为十六进制颜色或支持的纯色。`);
      result[key] = color;
    } else if (key === 'fontFamily') {
      result[key] = fontFamily(entry);
    } else if (Object.hasOwn(ranges, key)) {
      const [lower, upper] = ranges[key];
      if (!Number.isFinite(entry) || entry < lower || entry > upper) throw new Error(`「${key}」须在 ${lower} 至 ${upper} 之间。`);
      result[key] = entry;
    } else {
      const option = key === 'textTransform' && typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
      if (!choices[key].has(option)) throw new Error(`「${key}」支持 ${[...choices[key]].join('、')}。`);
      result[key] = option;
    }
  }
  return result;
}

export function updateDesignStyle(layer, delta) {
  if (delta === undefined) return;
  if (delta === null) {
    delete layer.style;
    return;
  }
  const style = { ...layer.style };
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) delete style[key];
    else style[key] = value;
  }
  if (Object.keys(style).length) layer.style = style;
  else delete layer.style;
}

function validateImageSource(value) {
  if (isAssetReference(value)) return;
  if (typeof value !== 'string' || value.length > 7_200_000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('图片图层需要项目素材引用或受控 PNG。');
  }
}

function normalizeShape(value) {
  const shape = value === 'rectangle' ? 'rect' : value === 'circle' ? 'ellipse' : value;
  if (!shapeNames.has(shape)) throw new Error('图形类型无效。');
  return shape;
}

function normalizePoints(value) {
  const invalid = () => new Error('图形坐标须为 2–160 个数值坐标对。');
  if (!Array.isArray(value) || value.length < 2 || value.length > 160) throw invalid();
  return Array.from(value, point => {
    if (!Array.isArray(point) || point.length !== 2) throw invalid();
    const [x, y] = point;
    if (![x, y].every(validCoordinate)) throw invalid();
    return [x, y];
  });
}

function validCoordinate(value) {
  return Number.isFinite(value) && Math.abs(value) <= maxVectorCoordinate;
}

function normalizeLayerFields(value, keys) {
  assertKeys(value, keys);
  const result = { ...value };
  if (Object.hasOwn(value, 'style')) result.style = normalizeDesignStyle(value.style);
  if (Object.hasOwn(value, 'gradient')) result.gradient = normalizeGradient(value.gradient);
  if (Object.hasOwn(value, 'mask')) result.mask = normalizeMask(value.mask);
  if (value.image != null) validateImageSource(value.image);
  if (Object.hasOwn(value, 'fit') && !fitModes.has(value.fit)) throw new Error('素材裁切方式无效。');
  if (Object.hasOwn(value, 'shape')) result.shape = normalizeShape(value.shape);
  if (Object.hasOwn(value, 'points')) result.points = normalizePoints(value.points);
  if (Object.hasOwn(value, 'd')) result.d = normalizeVectorPath(value.d);
  if (Object.hasOwn(value, 'decorations') && !['default', 'none'].includes(value.decorations)) throw new Error('底图装饰设置无效。');
  return result;
}

function valuesForSet(change) {
  const { op, id, set, ...flat } = change;
  if (!Object.hasOwn(change, 'set')) return flat;
  if (!record(set)) throw new Error('set 须为图层字段对象。');
  const duplicate = Object.keys(flat).find(key => Object.hasOwn(set, key));
  if (duplicate) throw new Error(`「${duplicate}」在 set 和操作外层各出现了一次，请只保留一处。`);
  return { ...flat, ...set };
}

function unit(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(label + '须在 0 到 1 之间。');
  return value;
}

function normalizeGradient(value) {
  if (value === null) return null;
  const type = value?.type;
  const linear = type === 'linear';
  if (!linear && type !== 'radial') throw new Error('渐变类型须为 linear 或 radial。');
  assertKeys(value, ['type', 'stops', ...(linear ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'r'])]);
  if (!Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 8) throw new Error('渐变需要 2–8 个颜色节点。');
  const stops = Array.from(value.stops, stop => {
    assertKeys(stop, ['offset', 'color', 'opacity']);
    if (typeof stop.offset !== 'number' || typeof stop.color !== 'string') throw new Error('渐变节点需要位置和颜色。');
    const { fill: color } = normalizeDesignStyle({ fill: stop.color });
    if (color === 'none') throw new Error('透明渐变请用节点透明度。');
    return { offset: unit(stop.offset, '渐变节点位置'), color: color === 'transparent' ? '#000000' : color,
      opacity: color === 'transparent' ? 0 : unit(stop.opacity, '渐变节点透明度', 1) };
  }).sort((left, right) => left.offset - right.offset);
  if (linear) {
    const x1 = unit(value.x1, '渐变起点 x', 0), y1 = unit(value.y1, '渐变起点 y', 0);
    const x2 = unit(value.x2, '渐变终点 x', 1), y2 = unit(value.y2, '渐变终点 y', 1);
    if (x1 === x2 && y1 === y2) throw new Error('渐变的起点和终点须不同。');
    return { type, stops, x1, y1, x2, y2 };
  }
  const r = unit(value.r, '渐变半径', .5);
  if (!r) throw new Error('渐变半径须大于 0。');
  return { type, stops, cx: unit(value.cx, '渐变中心 x', .5), cy: unit(value.cy, '渐变中心 y', .5), r };
}

function normalizeMask(value) {
  if (value === null) return null;
  assertKeys(value, ['mode', 'parts', 'viewWidth', 'viewHeight']);
  if (value.mode !== 'reveal' && value.mode !== 'cutout') throw new Error('遮罩模式须为 reveal 或 cutout。');
  if (!Array.isArray(value.parts) || !value.parts.length || value.parts.length > 12) throw new Error('每个遮罩需要 1–12 个部件。');
  const parts = normalizeVectorParts(value.parts);
  for (const part of parts) {
    if (part.style) assertKeys(part.style, maskPartStyle);
  }
  const { mode, viewWidth, viewHeight } = value;
  if (viewWidth === undefined && viewHeight === undefined) return { mode, parts };
  if (![viewWidth, viewHeight].every(size => Number.isFinite(size) && size > 0 && size <= maxVectorCoordinate)) {
    throw new Error('遮罩视口需要有效的宽度和高度。');
  }
  return { mode, parts, viewWidth, viewHeight };
}

function normalizeVectorPart(value, previous) {
  if (!record(value)) throw new Error('矢量子图形须使用结构化数据。');
  const shape = previous?.shape ?? normalizeShape(value.shape);
  if (!Object.hasOwn(vectorPartFields, shape)) throw new Error('矢量子图形须为路径、线段、折线、多边形、矩形或椭圆。');
  if (shape !== 'rect' && shape !== 'ellipse' && ['x', 'y', 'w', 'h'].some(key => Object.hasOwn(value, key))) {
    throw new Error(`${shape} 部件请用 ${shape === 'path' ? 'd' : 'points'} 描述局部坐标；整体的 x、y、w、h 放在 draw.layer。`);
  }
  const keys = [...vectorPartFields[shape], 'style', ...(previous ? [] : ['id', 'shape'])];
  if (value.style != null) assertKeys(value.style, vectorPartStyle);
  const { style, ...fields } = normalizeLayerFields(value, keys);
  const part = { ...previous, ...fields, id: previous?.id ?? assertId(value.id), shape };
  updateDesignStyle(part, style);

  if (shape === 'path' && !part.d) throw new Error('矢量路径缺少绘图数据。');
  if (shape === 'line' && part.points?.length !== 2) throw new Error('矢量线段需要两个坐标点。');
  if (shape === 'polyline' && !(part.points?.length >= 2)) throw new Error('矢量折线至少需要两个坐标点。');
  if (shape === 'polygon' && !(part.points?.length >= 3)) throw new Error('矢量多边形至少需要三个坐标点。');
  if ((shape === 'rect' || shape === 'ellipse') &&
      (![part.x, part.y, part.w, part.h].every(validCoordinate) || part.w <= 0 || part.h <= 0)) {
    throw new Error('矩形或椭圆需要位置和正数尺寸。');
  }
  return part;
}

function assertVectorParts(value) {
  if (!Array.isArray(value) || !value.length || value.length > maxVectorParts) throw new Error(`复合矢量图层需要 1–${maxVectorParts} 个子图形。`);
}

function normalizeVectorParts(value) {
  assertVectorParts(value);
  const parts = Array.from(value, part => normalizeVectorPart(part));
  if (new Set(parts.map(part => part.id)).size !== parts.length) throw new Error('同一矢量图层内的子图形 ID 须唯一。');
  return parts;
}

function applyVectorPartChanges(changes, previous = []) {
  if (!Array.isArray(changes) || !changes.length || changes.length > maxVectorParts) throw new Error(`子图形操作须为 1–${maxVectorParts} 项。`);
  const parts = new Map(previous.map(part => [part.id, part]));
  for (const change of changes) {
    if (!record(change)) throw new Error('子图形操作无效。');
    if (change.op === 'add') {
      assertKeys(change, ['op', 'part']);
      const part = normalizeVectorPart(change.part);
      if (parts.has(part.id)) throw new Error(`子图形 ${part.id} 已存在。`);
      parts.set(part.id, part);
    } else if (change.op === 'set' || change.op === 'delete') {
      if (change.op === 'delete') assertKeys(change, ['op', 'id']);
      const id = assertId(change.id);
      if (!parts.has(id)) throw new Error(`找不到子图形 ${id}。`);
      if (change.op === 'set') parts.set(id, normalizeVectorPart(valuesForSet(change), parts.get(id)));
      else parts.delete(id);
    } else throw new Error('子图形操作须为 add、set 或 delete。');
  }
  return normalizeVectorParts([...parts.values()]);
}

function normalizeVectorFields(fields, previous) {
  if (Object.hasOwn(fields, 'parts')) {
    if (Object.hasOwn(fields, 'partChanges')) throw new Error('请选择整体替换或逐个修改子图形。');
    fields.parts = normalizeVectorParts(fields.parts);
  } else if (Object.hasOwn(fields, 'partChanges')) {
    fields.parts = applyVectorPartChanges(fields.partChanges, previous?.parts);
    delete fields.partChanges;
  }
  return fields;
}

export function validateDesignElement(scene, element) {
  if (element.gradient && (element.type === 'image' || element.id === 'qr' || (element.id === 'visual' && element.asset === 'uploaded'))) {
    throw new Error('图片和二维码可加遮罩。渐变请放在文字、背景或矢量图层。');
  }
  if (isBuiltInElement(element.id)) return;
  if (!Object.hasOwn(customFields, element.type)) throw new Error('附加图层须为文字、图形、复合矢量或图片。');
  if (element.type === 'text' && (typeof element.text !== 'string' || !element.text.trim() || element.text.length > 700 || element.text.split('\n').length > 12)) {
    throw new Error('附加文字需要内容，最多 700 字或 12 行。');
  }
  if (element.type === 'image') validateImageSource(element.image);
  if (element.type === 'vector' || element.type === 'shape') {
    const minimum = element.type === 'vector' ? .01 : 0;
    const maxViewport = Math.max(scene.width, scene.height, posterPaperLimits.maxHeight * paperUnitsPerMm) * 16;
    if (![element.viewWidth, element.viewHeight].every(value => Number.isFinite(value) && value > minimum && value <= maxViewport)) {
      throw new Error('图形视口须为有效的正数尺寸。');
    }
  }
  if (element.type === 'vector') assertVectorParts(element.parts);
  if (element.type !== 'shape') return;
  if (!shapeNames.has(element.shape)) throw new Error('图形图层缺少图形类型。');
  if (element.shape === 'path' && !element.d) throw new Error('路径图形缺少 SVG 路径。');
  if (element.shape === 'polygon' && !(element.points?.length >= 3)) throw new Error('多边形至少需要三个坐标点。');
  if (element.shape === 'polyline' && !(element.points?.length >= 2)) throw new Error('折线至少需要两个坐标点。');
  if (element.shape === 'line' && element.points && element.points.length !== 2) throw new Error('线段需要两个坐标点。');
}

export function validateVectorBudget(scene) {
  let parts = 0;
  let coordinates = 0;
  for (const layer of scene.elements) {
    for (const geometry of [layer.type === 'vector' ? layer.parts : null, layer.mask?.parts]) {
      if (!geometry) continue;
      parts += geometry.length;
      for (const part of geometry) coordinates += (part.d?.length ?? 0) + (part.points?.length ?? 0) * 24;
    }
  }
  if (parts > 256 || coordinates > 120_000) throw new Error('这张海报的矢量细节过多，请简化部分路径或拆分设计。');
}

export function normalizeDesignPatches(raw, scene) {
  const patches = Array.isArray(raw) ? raw : raw?.patches;
  if (!Array.isArray(patches) || !patches.length || patches.length > 30) throw new Error('改稿须包含 1–30 项图层操作。');
  const known = new Map(scene.elements.map(element => [element.id, element]));
  const found = id => {
    assertId(id);
    if (!known.has(id)) throw new Error(`找不到图层 ${id}。`);
    return known.get(id);
  };
  return patches.map(patch => {
    if (!record(patch)) throw new Error('图层操作无效。');
    const op = patch.op ?? 'set';
    if (op === 'resize') {
      assertKeys(patch, ['op', 'preset', 'widthMm', 'heightMm']);
      const { widthMm, heightMm } = posterPaper(patch);
      return { op, widthMm, heightMm };
    }
    if (op === 'set') {
      const element = found(patch.id);
      const specific = isBuiltInElement(element.id) ? builtInFields[element.id] : customFields[element.type];
      const keys = element.id === 'palette' ? builtInFields.palette : [...sharedFields, ...(specific ?? [])];
      const set = normalizeLayerFields(valuesForSet(patch), keys);
      if (element.type === 'vector') {
        normalizeVectorFields(set, element);
        if (Object.hasOwn(set, 'parts')) known.set(element.id, { ...element, parts: set.parts });
      }
      return { op, id: patch.id, set };
    }
    if (op === 'add' || op === 'upsert') {
      assertKeys(patch, ['op', 'element']);
      if (!record(patch.element)) throw new Error('未指定要加入的图层。');
      const input = patch.element;
      const id = assertId(input.id ?? nextElementId({ elements: [...known.values()] }, input.type));
      if (isBuiltInElement(id) || (op === 'add' && known.has(id))) throw new Error(`图层 ${id} 已存在。`);
      const existing = known.get(id);
      const type = input.type ?? existing?.type;
      const previous = existing?.type === type ? existing : undefined;
      if (!Object.hasOwn(customFields, type)) throw new Error('附加图层须为文字、图形、复合矢量或图片。');
      const supplied = normalizeLayerFields(input, ['id', 'type', ...sharedFields, ...customFields[type]]);
      if (type === 'vector') normalizeVectorFields(supplied, previous);
      const element = { ...previous, ...supplied, id, type };
      element.label ??= { text: '新文字', shape: '新图形', vector: '新矢量图形', image: '导入图片' }[type];
      if (type === 'shape' || type === 'vector') {
        element.viewWidth ??= element.w;
        element.viewHeight ??= element.h;
      }
      known.set(id, element);
      if (known.size > 144) throw new Error('单张海报最多包含 144 个图层。');
      return { op, element: previous ? { ...supplied, id, type } : element };
    }
    if (op === 'delete') {
      assertKeys(patch, ['op', 'id']);
      found(patch.id);
      if (patch.id === 'palette') throw new Error('画布底层不能删除。');
      if (!isBuiltInElement(patch.id)) known.delete(patch.id);
      return { op, id: patch.id };
    }
    if (op === 'reorder') {
      assertKeys(patch, ['op', 'id', 'before', 'after', 'index']);
      found(patch.id);
      const placement = ['before', 'after', 'index'].filter(key => Object.hasOwn(patch, key));
      if (patch.id === 'palette' || placement.length !== 1) throw new Error('重新排序时请给出一个有效层级位置。');
      const target = patch[placement[0]];
      if (placement[0] === 'index') {
        if (!Number.isInteger(target) || target < 1 || target >= known.size) throw new Error('图层位置超出范围。');
      } else {
        found(target);
        if (target === patch.id || (placement[0] === 'before' && target === 'palette')) throw new Error('图层不能移动到自身或画布底层之前。');
      }
      return { op, id: patch.id, [placement[0]]: target };
    }
    if (op === 'group') {
      assertKeys(patch, ['op', 'group', 'ids']);
      if (!Array.isArray(patch.ids)) throw new Error('分组缺少图层。');
      return { op, group: patch.group, ids: [...new Set(patch.ids.map(id => found(id).id))] };
    }
    if (op === 'ungroup' || op === 'moveGroup') {
      assertKeys(patch, ['op', 'group', ...(op === 'moveGroup' ? ['dx', 'dy'] : [])]);
      return { ...patch, op };
    }
    throw new Error(`不支持 ${op} 图层操作。`);
  });
}
