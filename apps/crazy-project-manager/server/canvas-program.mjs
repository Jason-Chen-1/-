import { canvasTools, runCanvasTool } from './canvas-tools.mjs';
import { designStyleSchema, normalizeDesignPatches, vectorPartSchema } from './design-tools.mjs';
import { applyPatch, palettes } from './poster.mjs';
import { posterPaperFormats, posterPaperLimits } from './poster-paper.mjs';

const [textTool, vectorTool] = canvasTools;
const textLayers = textTool.function.parameters.properties.layers;
const vectorLayer = vectorTool.function.parameters.properties.layer;
const maskParts = { type: 'array', minItems: 1, maxItems: 12, items: vectorPartSchema({ mask: true }) };
const fraction = { type: 'number', minimum: 0, maximum: 1 };
const coordinate = { type: 'number' };
const paperPresets = { type: 'string', enum: posterPaperFormats };
const arrangeOperations = { type: 'array', minItems: 1, maxItems: 30, items: {
  type: 'object',
  description: 'Set a layer with {"op":"set","id":"title","set":{"x":40,"y":70}}. The shorter {"op":"set","id":"title","x":40,"y":70} also works.',
  properties: {
    op: { type: 'string', enum: ['set', 'add', 'upsert', 'delete', 'reorder', 'group', 'ungroup', 'moveGroup'] },
    id: { type: 'string' }, set: { type: 'object', description: 'Layer values such as x, y, w, h, hidden, and style. Omit duplicate outer values.',
      properties: { x: coordinate, y: coordinate, w: coordinate, h: coordinate, hidden: { type: 'boolean' }, style: designStyleSchema } },
    x: coordinate, y: coordinate, w: coordinate, h: coordinate, hidden: { type: 'boolean' }, style: designStyleSchema,
    element: { type: 'object' }, before: { type: 'string' }, after: { type: 'string' }, index: { type: 'integer' },
    group: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, dx: coordinate, dy: coordinate,
  },
} };

export const canvasProgramTool = { type: 'function', function: {
  name: 'run_canvas',
  description: 'Execute SVG edits in order. Use resize for portrait paper, text for editable type, draw for vector artwork, paint for layer styles, palette for backgrounds, and arrange for layer moves. A path part has id, shape:"path", d, and optional style.',
  parameters: { type: 'object', required: ['commands'], properties: {
    commands: { type: 'array', minItems: 1, maxItems: 12, items: {
      type: 'object', required: ['op'], properties: {
        op: { type: 'string', enum: ['resize', 'text', 'draw', 'paint', 'palette', 'arrange'] },
        id: { type: 'string', description: 'Target layer ID for paint.' },
        layers: textLayers, layer: vectorLayer,
        style: designStyleSchema,
        gradient: { type: ['object', 'null'], description: 'Use null to remove a gradient.', properties: {
          type: { type: 'string', enum: ['linear', 'radial'] },
          x1: fraction, y1: fraction, x2: fraction, y2: fraction, cx: fraction, cy: fraction, r: fraction,
          stops: { type: 'array', minItems: 2, maxItems: 8, items: {
            type: 'object', required: ['offset', 'color'], properties: { offset: fraction, color: { type: 'string' }, opacity: fraction }
          } }
        } },
        mask: { type: ['object', 'null'], description: 'Use layer-local pixel coordinates. null removes a mask.', properties: {
          mode: { type: 'string', enum: ['reveal', 'cutout'] }, parts: maskParts, viewWidth: coordinate, viewHeight: coordinate,
        } },
        preset: { type: 'string', enum: [...Object.keys(palettes), ...posterPaperFormats], description: 'Paper for resize (A4, A3 or A2), or colors for palette.' },
        widthMm: { type: 'integer', minimum: posterPaperLimits.minWidth, maximum: posterPaperLimits.maxWidth, description: 'Custom portrait width for resize. Supply heightMm too and omit preset.' },
        heightMm: { type: 'integer', minimum: posterPaperLimits.minHeight, maximum: posterPaperLimits.maxHeight, description: 'Custom portrait height for resize, greater than widthMm.' },
        decorations: { type: 'string', enum: ['default', 'none'] },
        operations: arrangeOperations,
      },
      allOf: [{ if: { properties: { op: { const: 'resize' } } }, then: {
        properties: { preset: paperPresets },
        oneOf: [{ required: ['preset'], not: { anyOf: [{ required: ['widthMm'] }, { required: ['heightMm'] }] } },
          { required: ['widthMm', 'heightMm'], not: { required: ['preset'] } }],
      } }],
    } },
    label: { type: 'string' }, reply: { type: 'string' }
  } }
} };

function paint(scene, command, id) {
  const layer = scene.elements.find(item => item.id === id);
  if (!layer) throw new Error('找不到图层 ' + String(id) + '。');
  const set = {};
  for (const key of ['style', 'gradient', 'mask']) if (Object.hasOwn(command, key)) set[key] = command[key];
  if (layer.gradient && !Object.hasOwn(set, 'gradient') && (command.style?.fill != null || command.style?.textColor != null)) set.gradient = null;
  if (command.op === 'palette') {
    if (Object.hasOwn(command, 'preset')) {
      set.preset = command.preset;
      if (!Object.hasOwn(set, 'gradient')) set.gradient = null;
      if (!command.style?.fill) set.style = { ...command.style, fill: null };
    }
    if (Object.hasOwn(command, 'decorations')) set.decorations = command.decorations;
  }
  if (!Object.keys(set).length) throw new Error('请提交颜色、渐变、遮罩或配色预设。');
  return [{ op: 'set', id, set }];
}

function drawingLayer(command) {
  const { layer } = command;
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return layer;
  const outer = ['parts', 'partChanges'].filter(key => Object.hasOwn(command, key));
  const duplicate = outer.find(key => Object.hasOwn(layer, key));
  if (duplicate) throw new Error(`draw.${duplicate} 和 draw.layer.${duplicate} 各出现了一次，请只保留一处。`);
  return outer.length ? { ...layer, ...Object.fromEntries(outer.map(key => [key, command[key]])) } : layer;
}

export function runCanvasProgram(base, { commands } = {}) {
  if (!Array.isArray(commands) || !commands.length || commands.length > 12) throw new Error('画布需要 1–12 条指令。');
  let scene = base;
  const patches = [];
  for (const command of commands) {
    let changes;
    switch (command?.op) {
      case 'resize': changes = [command]; break;
      case 'text': changes = runCanvasTool(scene, 'edit_text', { layers: command.layers }); break;
      case 'draw': changes = runCanvasTool(scene, 'draw_vector', { layer: drawingLayer(command) }); break;
      case 'paint': changes = paint(scene, command, command.id); break;
      case 'palette': changes = paint(scene, command, 'palette'); break;
      case 'arrange': changes = command.operations; break;
      default: throw new Error('无法识别这条画布指令。');
    }
    const normalized = normalizeDesignPatches(changes, scene);
    if (patches.length + normalized.length > 30) throw new Error('单次改稿最多包含 30 项图层操作。');
    scene = applyPatch(scene, normalized).scene;
    patches.push(...normalized);
  }
  return { scene, patches };
}
