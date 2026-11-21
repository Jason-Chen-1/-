import { designStyleSchema, nextElementId, vectorPartSchema } from './design-tools.mjs';

const string = { type: 'string' };
const number = { type: 'number' };
const frame = { x: number, y: number, w: number, h: number };
const vectorPart = vectorPartSchema();

export const canvasTools = [
  { type: 'function', function: {
    name: 'edit_text', description: 'Create text or set type and position for an existing text layer. For existing event info, omit text and use style to keep its confirmed facts.',
    parameters: { type: 'object', required: ['layers'], properties: {
      layers: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: {
        id: string, label: string, text: string, ...frame, style: designStyleSchema
      } } }
    } }
  } },
  { type: 'function', function: {
    name: 'draw_vector', description: 'Create editable artwork with a new id such as hero-art. Keep the layer x, y, w and h on layer. Inside parts, paths use d, lines and polygons use points, and only rectangles and ellipses use x, y, w and h. A hidden, empty visual placeholder maps to visual-art.',
    parameters: { type: 'object', required: ['layer'], properties: {
      layer: { type: 'object', properties: {
        id: string, label: string, ...frame, viewWidth: number, viewHeight: number, style: designStyleSchema,
        parts: { type: 'array', minItems: 1, maxItems: 32, items: vectorPart },
        partChanges: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['op'], properties: {
          op: { type: 'string', enum: ['set', 'add', 'delete'] }, id: string,
          set: { type: 'object', description: 'Update the existing part using the geometry fields for its current shape.' }, part: vectorPart,
        } } }
      } }
    } }
  } }
];

const record = value => value && typeof value === 'object' && !Array.isArray(value);

function textOperations(scene, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 12) throw new Error('请提供 1–12 个文字图层操作。');
  return entries.map(entry => {
    if (!record(entry)) throw new Error('文字图层格式无效。');
    const { id, ...fields } = entry;
    const prior = scene.elements.find(element => element.id === id);
    if (prior && id !== 'info' && typeof prior.text !== 'string' && prior.type !== 'text') throw new Error(`图层 ${id} 不是可直接编辑的文字图层。`);
    if (id === 'info' && Object.hasOwn(fields, 'text')) throw new Error('info 从项目简报读取日期与场地，调整位置或排版时请省略 text。');
    if (prior) return { op: 'set', id, set: fields };
    return { op: 'add', element: { ...fields, id, type: 'text' } };
  });
}

function vectorOperation(scene, raw) {
  if (!record(raw)) throw new Error('需要一个矢量图层。');
  const { id, parts, partChanges, ...fields } = raw;
  const requested = scene.elements.find(element => element.id === id);
  const placeholder = id === 'visual' && requested?.hidden && requested.asset !== 'uploaded' && !requested.image ? requested : null;
  let targetId = id;
  if (placeholder) {
    const artwork = scene.elements.find(element => element.id === 'visual-art');
    targetId = artwork && artwork.type !== 'vector' ? nextElementId(scene, 'visual-art') : 'visual-art';
  }
  const prior = scene.elements.find(element => element.id === targetId);
  if (prior && prior.type !== 'vector') throw new Error(`图层 ${id} 不是复合矢量图层。请给 draw.layer.id 一个新 ID，例如 hero-art。`);
  if (parts != null && (!Array.isArray(parts) || parts.length > 32)) throw new Error('矢量图层最多接收 32 个部件。');
  if (partChanges != null && (!prior || !Array.isArray(partChanges) || partChanges.length > 32)) throw new Error('请提供有效的矢量图层部件改动。');
  const layer = { ...fields };
  if (placeholder && !prior) {
    for (const coordinate of Object.keys(frame)) layer[coordinate] ??= placeholder[coordinate];
  }
  if (parts != null) layer.parts = parts;
  if (partChanges != null) layer.partChanges = partChanges;
  if (prior) return { op: 'set', id: targetId, set: layer };
  if (!layer.parts?.length) throw new Error('新矢量图层需要至少一个图形部件。');
  return { op: 'add', element: { ...layer, id: targetId, type: 'vector' } };
}

export function runCanvasTool(scene, name, args) {
  if (!record(args)) throw new Error('画布工具参数须为对象。');
  if (name === 'edit_text') return textOperations(scene, args.layers);
  if (name === 'draw_vector') return [vectorOperation(scene, args.layer)];
  throw new Error('未识别的画布工具。');
}

