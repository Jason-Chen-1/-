import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { isAssetReference, isBuiltInElement, normalizeDesignPatches, updateDesignStyle, validateDesignElement, validateVectorBudget } from './design-tools.mjs';
import { canvasDimensions, paperUnitsPerMm, posterPaper } from './poster-paper.mjs';

const facts = Object.freeze({
  title: '夜游美术馆',
  venue: '未眠美术馆',
  date: '11.21 — 12.21',
  hours: '18:00 — 22:00',
  gate: '东门入场',
  admission: '免费',
  reservation: '须预约',
  credits: '主办 未眠美术馆 · 联合主办 城市艺术空间',
});

export const theme = Object.freeze({
  id: 'museum-night',
  name: facts.title,
  width: 600,
  height: 800,
  briefVersion: '1.0',
  rulesVersion: '1.0',
  brief: '未眠美术馆夜间特别开放。展期 11.21 至 12.21，每日 18:00 至 22:00。活动免费，须预约，东门入场。海报将发布至手机端，展名优先，右上或左下须保留授权白标、净空和联合主办署名。',
  facts,
  previewWidth: 300,
  reservationPath: '/reservation',
  assets: Object.freeze({
    approvedLogo: 'museum-white-v1',
    oldLogo: 'museum-archive-v0',
    mainVisual: 'orbit-night-v1',
  }),
  approvedPalettes: Object.freeze(['green', 'purple']),
});

export const palettes = Object.freeze({
  green: Object.freeze({ bg: '#14261f', accent: '#d7f6a5', fine: '#9db193', ribbon: '#7fa58b', label: '深绿' }),
  purple: Object.freeze({ bg: '#251c43', accent: '#e3d4fd', fine: '#c1b2d4', ribbon: '#9583ce', label: '夜紫' }),
  blue: Object.freeze({ bg: '#273b54', accent: '#f2cb80', fine: '#adc1d3', ribbon: '#84abc7', label: '蓝金' }),
  'mono-light': Object.freeze({ bg: '#ffffff', accent: '#000000', fine: '#444444', ribbon: '#7d7d7d', label: '白底黑字', monochrome: true }),
  'mono-dark': Object.freeze({ bg: '#000000', accent: '#ffffff', fine: '#cccccc', ribbon: '#737373', label: '黑底白字', monochrome: true }),
});

export function defaultLogoColor(asset, colors) {
  const approved = asset === theme.assets.approvedLogo;
  if (colors.monochrome) return approved ? colors.accent : colors.fine;
  return approved ? '#f5f7f2' : '#94a6a0';
}

export const defaultReservationUrl = `http://127.0.0.1:4173${theme.reservationPath}`;

export function projectTitle(text) {
  const characters = Array.from(text);
  const weight = letters => letters.reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 1 : .59), 0);
  let lines = [characters];
  if (weight(characters) > 7) {
    const middle = Math.ceil(characters.length / 2);
    const spaces = characters.flatMap((letter, index) => letter === ' ' && Math.abs(index - middle) <= 3 ? [index] : []);
    const cut = spaces.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? middle;
    lines = [characters.slice(0, cut), characters.slice(cut)];
  }
  const widest = Math.max(...lines.map(weight));
  const size = Math.max(35, Math.min(lines.length > 1 ? 98 : 104, Math.floor(510 / widest)));
  return { text: lines.map(letters => letters.join('').trim()).join('\n'), size };
}

export function createScene({ reservationUrl = defaultReservationUrl, project = theme } = {}) {
  const url = new URL(reservationUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 300) {
    throw new Error('预约页地址须为有效的 HTTP(S) 链接。');
  }

  const scene = {
    themeId: theme.id,
    width: theme.width,
    height: theme.height,
    reservationUrl: url.href,
    elements: [
      { id: 'palette', label: '底色与夜游配色', x: 0, y: 0, w: 600, h: 800, preset: 'green' },
      { id: 'visual', label: '环形主视觉', x: 35, y: 305, w: 530, h: 309, asset: theme.assets.mainVisual, image: null, imageName: '' },
      { id: 'title', label: '展名', x: 35, y: 82, w: 400, h: 216, text: '夜游\n美术馆', size: 100, weight: 800 },
      { id: 'tagline', label: '宣传语', x: 205, y: 628, w: 357, h: 25, text: '把夜晚，交给艺术。', size: 16 },
      { id: 'logo', label: '馆标', x: 430, y: 25, w: 132, h: 38, asset: theme.assets.approvedLogo },
      { id: 'info', label: '展期、时段与入场', x: 36, y: 678, w: 270, h: 84, date: facts.date, hours: facts.hours, venue: facts.venue, gate: facts.gate, size: 18 },
      { id: 'credits', label: '联合主办署名', x: 36, y: 769, w: 403, h: 16, text: facts.credits, size: 13 },
      { id: 'qr', label: '预约二维码', x: 466, y: 665, w: 96, h: 96, url: url.href },
      { id: 'sticker', label: '预约提示', x: 342, y: 735, w: 107, h: 23, text: '免费 · 须预约', size: 12, treatment: 'plain' },
    ],
  };
  if (!project.custom) return scene;

  scene.project = { name: project.name, brief: project.brief, facts: project.facts };
  const { title, venue, date, credits, organizer } = project.facts;
  const changes = {
    palette: { label: '底色与主配色', preset: 'purple' },
    title: { label: '项目标题', x: 34, y: 92, w: 530, h: 213, ...projectTitle(title) },
    tagline: { x: 36, w: 525, text: Array.from(project.brief).slice(0, 24).join(''), hidden: !project.brief },
    logo: { label: '主办方标志', hidden: !organizer },
    info: { label: '时间与地点', date, hours: '', venue, gate: '', w: 515 },
    credits: { label: '主办方署名', text: credits },
    sticker: { label: '活动角标', text: '', hidden: true },
    qr: { url: '', hidden: true }
  };
  scene.elements.forEach(layer => Object.assign(layer, changes[layer.id]));
  return scene;
}

export const initialScene = createScene();

export function getElement(scene, id) {
  const element = scene.elements.find(entry => entry.id === id);
  if (!element) throw new Error(`找不到图层 ${id}。`);
  return element;
}

export function intersection(first, second) {
  if (first.hidden || second.hidden) return 0;
  const width = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
  const height = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y);
  return Math.max(0, width) * Math.max(0, height);
}

export function separation(first, second) {
  return Math.max(first.x - second.x - second.w, second.x - first.x - first.w, first.y - second.y - second.h, second.y - first.y - first.h);
}

function assertText(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0B-\x1F\x7F]/.test(value)) {
    throw new Error(`文字最多可含 ${limit} 个字符，且须为普通文本。`);
  }
}

function validateElement(scene, element, previous) {
  const { x, y, w, h, size, hidden, group } = element;
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > scene.width || y + h > scene.height) {
    throw new Error(`「${element.label}」超出 ${scene.width} × ${scene.height} 画布。`);
  }
  if (hidden !== undefined && typeof hidden !== 'boolean') throw new Error('图层显隐值无效。');
  if (group !== undefined && group !== null && (typeof group !== 'string' || !/^[\w-]{1,40}$/.test(group))) throw new Error('图层组名称无效。');
  assertText(element.label, 100);
  if (size !== undefined && (!Number.isFinite(size) || size < 6 || size > 200)) throw new Error('字号须在 6–200 之间。');
  if (element.text !== undefined || ['title', 'tagline', 'credits', 'sticker'].includes(element.id)) {
    assertText(element.text, element.type === 'text' ? 700 : element.id === 'title' ? 100 : 240);
  }
  if (element.id === 'palette' && !Object.hasOwn(palettes, element.preset)) throw new Error('未找到这套主题配色。');
  if (element.id === 'title' && (!Number.isInteger(element.weight) || element.weight < 100 || element.weight > 900)) throw new Error('标题字重须在 100–900 之间。');
  if (element.id === 'title' && element.text.split('\n').length > 8) throw new Error('标题最多分八行。');
  if (element.id === 'visual' && ![theme.assets.mainVisual, 'uploaded'].includes(element.asset)) throw new Error('主视觉素材不存在。');
  if (element.id === 'visual' && element.asset === 'uploaded' && !element.image) throw new Error('主视觉缺少上传素材。');
  if (element.imageName !== undefined) assertText(element.imageName, 180);
  if (element.image && element.image !== previous?.image && !isAssetReference(element.image)) verifyUploadPng(element.image);
  if (element.id === 'logo' && ![theme.assets.approvedLogo, theme.assets.oldLogo].includes(element.asset)) throw new Error('馆标素材不存在。');
  if (element.id === 'sticker' && !['plain', 'yellow', 'callout'].includes(element.treatment)) throw new Error('预约提示样式无效。');
  if (element.id === 'info') for (const key of ['date', 'hours', 'venue', 'gate']) assertText(element[key], 42);
  if (element.id === 'qr' && element.url !== '') {
    const url = new URL(element.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 300) throw new Error('预约码链接无效。');
  }
  validateDesignElement(scene, element);
}

function updateLayer(layer, changes) {
  const { style, ...fields } = changes;
  Object.assign(layer, fields);
  if (layer.id === 'visual' && fields.asset === 'uploaded' && !Object.hasOwn(fields, 'gradient')) delete layer.gradient;
  updateDesignStyle(layer, style);
  if (isBuiltInElement(layer.id) && typeof layer.size === 'number') {
    if (style?.fontSize != null) layer.size = style.fontSize;
    else if (Object.hasOwn(fields, 'size') && layer.style) delete layer.style.fontSize;
  }
  if (layer.id === 'title') {
    if (style?.fontWeight != null) layer.weight = style.fontWeight;
    else if (Object.hasOwn(fields, 'weight') && layer.style) delete layer.style.fontWeight;
  }
  if (layer.id === 'visual' && Object.hasOwn(fields, 'image') && !Object.hasOwn(fields, 'asset')) {
    layer.asset = layer.image ? 'uploaded' : theme.assets.mainVisual;
  }
  return layer;
}

function layerPatch(next, patch) {
  const layer = getElement(next, patch.id);
  updateLayer(layer, patch.set);
  return layer;
}

function groupPatch(next, patch) {
  if (typeof patch.group !== 'string' || !/^[\w-]{1,40}$/.test(patch.group)) throw new Error('图层组名称无效。');
  if (patch.op === 'group') {
    if (!Array.isArray(patch.ids) || new Set(patch.ids).size < 2 || patch.ids.includes('palette')) throw new Error('分组须包含至少两个可移动图层。');
    return patch.ids.map(id => layerPatch(next, { id, set: { group: patch.group } }));
  }
  const members = next.elements.filter(element => element.group === patch.group);
  if (!members.length) throw new Error(`找不到图层组 ${patch.group}。`);
  if (patch.op === 'ungroup') return members.map(element => layerPatch(next, { id: element.id, set: { group: null } }));
  if (![patch.dx, patch.dy].every(Number.isFinite)) throw new Error('图层组的位移须为数字。');
  return members.map(element => layerPatch(next, { id: element.id, set: { x: element.x + patch.dx, y: element.y + patch.dy } }));
}

function resizeLayer(layer, width, height, scaleX, scaleY) {
  const scale = Math.min(scaleX, scaleY);
  const preserveShape = layer.id === 'logo' || layer.id === 'qr';
  const widthScale = preserveShape ? scale : scaleX;
  const heightScale = preserveShape ? scale : scaleY;
  const x = layer.x * scaleX + layer.w * (scaleX - widthScale) / 2;
  const y = layer.y * scaleY + layer.h * (scaleY - heightScale) / 2;
  const w = Math.min(layer.w * widthScale, width - x);
  const h = Math.min(layer.h * heightScale, height - y);
  const scaleLength = (value, lower, upper) => Math.min(upper, Math.max(lower, value * scale));
  const { style } = layer;
  const localGeometry = layer.type === 'vector' || (layer.type === 'shape' && ['path', 'line', 'polygon', 'polyline'].includes(layer.shape)) || preserveShape;

  if (layer.mask && layer.mask.viewWidth === undefined && (layer.w !== w || layer.h !== h)) {
    Object.assign(layer.mask, { viewWidth: layer.w, viewHeight: layer.h });
  }
  Object.assign(layer, { x, y, w, h });
  if (scale === 1) return;
  if (Number.isFinite(layer.size)) layer.size = scaleLength(layer.size, 6, 200);
  if (layer.type === 'text' || style?.fontSize !== undefined) {
    layer.style = { ...style, fontSize: scaleLength(style?.fontSize ?? 24, 6, 200) };
  }
  if (style?.letterSpacing !== undefined) layer.style.letterSpacing = scaleLength(style.letterSpacing, -20, 100);
  if (!localGeometry && style?.strokeWidth !== undefined) layer.style.strokeWidth = scaleLength(style.strokeWidth, 0, 100);
  if (!localGeometry && style?.radius !== undefined) layer.style.radius = scaleLength(style.radius, 0, 500);
}

function resizeCanvas(scene, patch, ids) {
  const paper = posterPaper(patch);
  const width = paper.widthMm * paperUnitsPerMm;
  const height = paper.heightMm * paperUnitsPerMm;
  if (width !== scene.width || height !== scene.height) {
    const scaleX = width / scene.width;
    const scaleY = height / scene.height;
    for (const layer of scene.elements) {
      resizeLayer(layer, width, height, scaleX, scaleY);
      ids.add(layer.id);
    }
  }
  Object.assign(scene, { width, height, paper });
}

function imageSummary(value) {
  if (!value) return null;
  if (value.startsWith('studio-asset:')) return `sha256:${value.slice(13)}`;
  return `sha256:${createHash('sha256').update(Buffer.from(value.split(',')[1], 'base64')).digest('hex')}`;
}

function differences(previous, next, ids, reordered = new Set()) {
  const lookup = scene => new Map(scene.elements.map((element, index) => [element.id, { element, index }]));
  const before = lookup(previous);
  const after = lookup(next);
  const diff = [];
  for (const id of ids) {
    const former = before.get(id);
    const present = after.get(id);
    const original = former?.element ?? {};
    const updated = present?.element ?? {};
    const changed = [...new Set([...Object.keys(original), ...Object.keys(updated)])].filter(key => JSON.stringify(original[key]) !== JSON.stringify(updated[key]));
    if (reordered.has(id) && former?.index !== present?.index) changed.push('zIndex');
    if (!changed.length) continue;
    const snapshot = row => row ? Object.fromEntries(changed.map(key => {
      const value = key === 'zIndex' ? row.index : row.element[key];
      return [key, key === 'image' ? imageSummary(value) : value ?? null];
    })) : {};
    diff.push({ id, before: snapshot(former), after: snapshot(present) });
  }
  return diff;
}

export function applyPatch(scene, patches) {
  const steps = normalizeDesignPatches(patches, scene);
  const next = structuredClone(scene);
  const ids = new Set();
  const reordered = new Set();
  for (const patch of steps) {
    const { op } = patch;
    if (op === 'resize') resizeCanvas(next, patch, ids);
    else if (op === 'add' || op === 'upsert') {
      const { element } = patch;
      const at = next.elements.findIndex(layer => layer.id === element.id);
      if (at === -1) next.elements.push(updateLayer({}, element));
      else next.elements[at] = updateLayer(next.elements[at].type === element.type ? next.elements[at] : {}, element);
      ids.add(element.id);
    } else if (op === 'set') ids.add(layerPatch(next, patch).id);
    else if (['group', 'ungroup', 'moveGroup'].includes(op)) {
      for (const layer of groupPatch(next, patch)) ids.add(layer.id);
    } else if (op === 'delete') {
      if (isBuiltInElement(patch.id)) getElement(next, patch.id).hidden = true;
      else next.elements.splice(next.elements.findIndex(layer => layer.id === patch.id), 1);
      ids.add(patch.id);
    } else {
      const [layer] = next.elements.splice(next.elements.findIndex(element => element.id === patch.id), 1);
      const index = patch.index ?? next.elements.findIndex(element => element.id === (patch.before ?? patch.after)) + Number(Boolean(patch.after));
      next.elements.splice(index, 0, layer);
      ids.add(layer.id);
      reordered.add(layer.id);
    }
  }
  for (const layer of next.elements) {
    if (ids.has(layer.id)) validateElement(next, layer, scene.elements.find(element => element.id === layer.id));
  }
  validateVectorBudget(next);
  const diff = differences(scene, next, ids, reordered);
  const before = { paper: null, ...canvasDimensions(scene) };
  const after = { paper: null, ...canvasDimensions(next) };
  if (JSON.stringify(before) !== JSON.stringify(after)) diff.unshift({ id: '$canvas', before, after });
  return { scene: next, diff };
}

// Validate the same non-interlaced PNG format produced by the upload canvas.
export function verifyUploadPng(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 7_200_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw new Error('请选择 5 MB 左右以内的 PNG 素材。');
  }
  return verifyPosterPngBytes(Buffer.from(dataUrl.slice(22), 'base64'));
}

export function verifyPosterPngBytes(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('utf8', 12, 16) !== 'IHDR') {
    throw new Error('图片缺少有效的 PNG 文件头。');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[bytes[25]];
  if (!width || !height || width > 2400 || height > 2400 || !channels || ![1, 2, 4, 8, 16].includes(depth) || bytes[28]) {
    throw new Error('PNG 须为最大边不超过 2400 像素的非交错图片。');
  }
  const idat = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const next = offset + length + 12;
    if (next > bytes.length || bytes.readUInt32BE(next - 4) !== crc32(bytes.subarray(offset + 4, next - 4))) break;
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, next - 4));
    if (type === 'IEND' && length === 0 && idat.length) {
      const stride = Math.ceil(width * channels * depth / 8) + 1;
      try {
        const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: stride * height });
        if (pixels.length === stride * height && pixels.every((value, index) => index % stride !== 0 || value <= 4)) return { width, height, bytes };
      } catch {
        // Report the same user-facing error for malformed image data.
      }
      break;
    }
    offset = next;
  }
  throw new Error('PNG 像素数据损坏，请重新选择文件。');
}

export function applyUpload(scene, rasterDataUrl, name = '上传图片') {
  verifyUploadPng(rasterDataUrl);
  assertText(name, 180);
  const next = structuredClone(scene);
  const visual = getElement(next, 'visual');
  Object.assign(visual, { asset: 'uploaded', image: rasterDataUrl, imageName: name, hidden: false });
  delete visual.gradient;
  return { scene: next, diff: differences(scene, next, ['visual']) };
}
