import { SVG } from '@svgdotjs/svg.js';
import { t } from '../i18n.js';
import './vector-canvas.css';

const tools = {
  select: t('选择', 'Select'), text: t('文字', 'Text'), rect: t('矩形', 'Rectangle'),
  ellipse: t('椭圆', 'Ellipse'), line: t('线段', 'Line'), path: t('画笔', 'Pen'),
};
const fonts = {
  sans: 'MuseumPoster, Microsoft YaHei, Noto Sans CJK SC, sans-serif',
  serif: 'MuseumSerif, Noto Serif SC, SimSun, Georgia, serif',
  mono: 'MuseumMono, Consolas, Microsoft YaHei, monospace',
};
const blendModes = {
  normal: t('正常', 'Normal'), multiply: t('正片叠底', 'Multiply'), screen: t('滤色', 'Screen'),
  overlay: t('叠加', 'Overlay'), darken: t('变暗', 'Darken'), lighten: t('变亮', 'Lighten'),
  'hard-light': t('强光', 'Hard light'), 'soft-light': t('柔光', 'Soft light'),
  difference: t('差值', 'Difference'), exclusion: t('排除', 'Exclusion'),
};
const imageFits = {
  contain: { label: t('完整显示', 'Contain'), aspect: 'xMidYMid meet' },
  cover: { label: t('铺满裁切', 'Cover'), aspect: 'xMidYMid slice' },
  fill: { label: t('拉伸填满', 'Fill'), aspect: 'none' },
};
const hasFill = kind => kind === 'rect' || kind === 'ellipse';
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const round = value => Math.round(value * 10) / 10;
const lineHeight = 1.12;

function element(tag, properties = {}, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

function control(text, className = 'button small') {
  return element('button', { className, type: 'button', textContent: text });
}

function field(label, input) {
  return element('label', { className: 'vector-canvas-field' }, element('span', { textContent: label }), input);
}

function selectOptions(labels) {
  return element('select', {}, ...Object.entries(labels).map(([value, textContent]) => element('option', { value, textContent })));
}

function layerBlend(layer) {
  return layer.blendMode && layer.blendMode !== 'normal' ? { blendMode: layer.blendMode } : undefined;
}

function atPosition(layer, x, y, width, height) {
  return { ...layer, x: clamp(round(x), 0, width - layer.w), y: clamp(round(y), 0, height - layer.h) };
}

function bounds(points) {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) };
}

function shapeLayer(kind, points, config) {
  const frame = bounds(points);
  return { kind, ...frame, points: points.map(([x, y]) => [round(x - frame.x), round(y - frame.y)]), config };
}

function shapeStyle({ kind, config }) {
  return {
    fill: hasFill(kind) && config.solid ? config.fill : 'none', stroke: config.stroke,
    strokeWidth: config.strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
  };
}

function pathData(points) {
  const start = `M${points[0].join(' ')}`;
  const curves = points.slice(1, -1).map(([x, y], index) => {
    const [nextX, nextY] = points[index + 2];
    return `Q${x} ${y} ${round((x + nextX) / 2)} ${round((y + nextY) / 2)}`;
  });
  return start + curves.join('') + `L${points.at(-1).join(' ')}`;
}

function vectorCall(layer, width, height) {
  const { kind, points } = layer;
  const style = shapeStyle(layer);
  const padding = Math.ceil(style.strokeWidth / 2) + 1;
  const x = Math.max(0, Math.floor(layer.x - padding));
  const y = Math.max(0, Math.floor(layer.y - padding));
  const w = Math.min(width, Math.ceil(layer.x + layer.w + padding)) - x;
  const h = Math.min(height, Math.ceil(layer.y + layer.h + padding)) - y;
  const offsetX = round(layer.x - x), offsetY = round(layer.y - y);
  const localPoints = points.map(([px, py]) => [round(px + offsetX), round(py + offsetY)]);
  const geometry = hasFill(kind) ? { x: offsetX, y: offsetY, w: layer.w, h: layer.h }
    : kind === 'line' ? { points: localPoints } : { d: pathData(localPoints) };
  return { name: 'draw_vector', arguments: { layer: {
    label: tools[kind], x, y, w, h, viewWidth: w, viewHeight: h,
    style: layerBlend(layer), parts: [{ id: 'shape', shape: kind, ...geometry, style }],
  } } };
}

function canvasCalls(layers, edits, width, height) {
  const calls = [];
  if (edits.size) {
    const operations = Array.from(edits, ([id, { fit, blendMode }]) => ({
      op: 'set', id, set: { ...(fit && { fit }), ...(blendMode && { style: { blendMode } }) },
    }));
    calls.push({ name: 'run_canvas', arguments: { commands: [{ op: 'arrange', operations }] } });
  }
  for (const layer of layers) {
    if (layer.kind !== 'text') {
      calls.push(vectorCall(layer, width, height));
      continue;
    }
    const { x, y, w, h, rows, config } = layer;
    const preceding = calls.at(-1);
    const batch = preceding?.name === 'edit_text' && preceding.arguments.layers.length < 12
      ? preceding : { name: 'edit_text', arguments: { layers: [] } };
    if (batch !== preceding) calls.push(batch);
    batch.arguments.layers.push({ label: tools.text, text: rows.join('\n'), x, y, w, h,
      style: { textColor: config.color, fontFamily: config.fontFamily, fontSize: config.fontSize, fontWeight: 400, lineHeight, ...layerBlend(layer) },
    });
  }
  return calls;
}

export function mountVectorCanvas(container, { width, height, previewUrl, onSave }) {
  const root = element('div', { className: 'vector-canvas' });
  const toolbar = element('div', { className: 'vector-canvas-tools' });
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', t('绘制工具', 'Drawing tools'));

  const paper = element('div', { className: 'vector-canvas-paper' });
  paper.style.setProperty('--vector-aspect', String(width / height));
  const stage = element('div', { className: 'vector-canvas-stage' }, paper);
  const drawing = SVG().addTo(paper).size('100%', '100%').viewbox(0, 0, width, height).attr({
    tabindex: '0', role: 'group', 'aria-label': t('海报画布', 'Poster canvas'),
  });
  const artwork = drawing.group(), overlay = drawing.group().attr({ 'pointer-events': 'none' });

  const text = element('textarea', { rows: 3, maxLength: 680, spellcheck: false });
  const family = element('select', {}, ...[['sans', t('无衬线', 'Sans serif')], ['serif', t('衬线', 'Serif')], ['mono', t('等宽', 'Monospace')]]
    .map(([value, textContent]) => element('option', { value, textContent })));
  const fontSize = element('input', { type: 'number', min: '6', max: '200', step: '1' });
  const textColor = element('input', { type: 'color' });
  const textOptions = element('div', { className: 'vector-canvas-options' }, field(t('内容', 'Content'), text),
    field(t('字体', 'Font'), family), element('div', { className: 'vector-canvas-pair' }, field(t('字号', 'Size'), fontSize), field(t('颜色', 'Color'), textColor)));

  const stroke = element('input', { type: 'color' });
  const strokeWidth = element('input', { type: 'number', min: '1', max: '40', step: '1' });
  const solid = element('input', { type: 'checkbox' });
  const fill = element('input', { type: 'color' });
  const fillOptions = element('div', { className: 'vector-canvas-pair' }, field(t('填充', 'Fill'), solid), field(t('填充色', 'Fill color'), fill));
  const shapeOptions = element('div', { className: 'vector-canvas-options' },
    element('div', { className: 'vector-canvas-pair' }, field(t('描边', 'Stroke'), stroke), field(t('线宽', 'Width'), strokeWidth)), fillOptions);

  const selection = element('select');
  const layerField = field(t('图层', 'Layer'), selection);
  const blendMode = selectOptions(blendModes);
  const blendField = field(t('混合模式', 'Blend mode'), blendMode);
  const fit = selectOptions(Object.fromEntries(Object.entries(imageFits).map(([mode, { label }]) => [mode, label])));
  const fitField = field(t('图片适配', 'Image fit'), fit);
  const inspector = element('div', { className: 'vector-canvas-inspector' }, layerField, blendField, fitField, textOptions, shapeOptions);
  const message = element('p', { className: 'vector-canvas-message' });
  message.setAttribute('role', 'status');
  const undo = control(t('撤销', 'Undo'));
  const remove = control(t('删除所选', 'Delete selected'));
  const save = control(t('加入草稿', 'Add to draft'), 'button primary small');
  root.append(toolbar, element('div', { className: 'vector-canvas-body' }, stage, inspector), message,
    element('div', { className: 'vector-canvas-actions' }, undo, remove, save));
  container.replaceChildren(root);

  const measuring = document.createElement('canvas').getContext('2d');
  const events = new AbortController();
  const listen = (target, name, handler) => target.addEventListener(name, handler, { signal: events.signal });
  let textDefaults = { text: t('新文字', 'New text'), fontFamily: 'sans', fontSize: 38, color: '#fff6e4' };
  let shapeDefaults = { stroke: '#fff6e4', strokeWidth: 4, solid: false, fill: '#f5d262' };
  let tool = 'select', layers = [], history = [], selected, gesture, nextId = 0, busy = false;
  let existingLayers = [], layerEdits = new Map(), poster;
  let error = '', previewError = '', saved = false, layerListKey;

  function selectedLayer() {
    return layers.find(layer => layer.id === selected) ?? existingLayers.find(layer => layer.id === selected);
  }

  function usePoster(frame) {
    const svg = frame.contentDocument?.documentElement;
    const layerGroup = svg?.namespaceURI === drawing.node.namespaceURI && [...svg.children].findLast(child =>
      child.localName === 'g' && [...child.children].some(layer => layer.matches('g[id][aria-label]')));
    if (!layerGroup) {
      frame.replaceWith(element('img', { src: previewUrl, alt: '', draggable: false, decoding: 'async' }));
      previewError = t('无法读取现有图层。', 'Could not load existing layers.');
      updateControls();
      return;
    }

    poster = svg;
    poster.setAttribute('width', '100%');
    poster.setAttribute('height', '100%');
    poster.style.display = 'block';
    existingLayers = [...layerGroup.children].filter(node => node.matches('g[id][aria-label]') && node.getAttribute('display') !== 'none').map(node => {
      const image = [...node.children].find(child => child.localName === 'image');
      const aspect = image?.getAttribute('preserveAspectRatio');
      const imageFit = Object.keys(imageFits).find(mode => imageFits[mode].aspect === aspect) ?? 'contain';
      return { id: node.id, label: node.getAttribute('aria-label'), node, image, fit: imageFit, blendMode: node.style.mixBlendMode || 'normal' };
    });
    layerGroup.append(artwork.node);
    updateControls(true);
    paintLayers();
  }

  function layerFrame(layer) {
    if (!layer?.node) return layer;
    const local = layer.node.getScreenCTM();
    const viewport = poster?.getScreenCTM();
    if (!local || !viewport) return null;
    const transform = viewport.inverse().multiply(local);
    const { x, y, width: w, height: h } = layer.node.getBBox();
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([x, y]) => {
      const point = new DOMPoint(x, y).matrixTransform(transform);
      return [point.x, point.y];
    });
    return bounds(corners);
  }

  function appearance(layer) {
    const edited = layerEdits.get(layer.id);
    return { blendMode: edited?.blendMode ?? layer.blendMode ?? 'normal', fit: edited?.fit ?? layer.fit };
  }

  function paintExistingStyles() {
    for (const layer of existingLayers) {
      const { blendMode, fit } = appearance(layer);
      layer.node.style.mixBlendMode = blendMode === 'normal' ? '' : blendMode;
      if (layer.image) layer.image.setAttribute('preserveAspectRatio', imageFits[fit].aspect);
    }
  }

  function textLayout(layer) {
    const { config, x, y } = layer;
    if (measuring) measuring.font = `${config.fontSize}px ${fonts[config.fontFamily]}`;
    const measure = value => measuring?.measureText(value).width ?? Array.from(value).length * config.fontSize;
    const rows = [];
    const source = config.text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\t/g, '  ').trim();
    for (const line of source.split('\n')) {
      let row = '';
      for (const character of line) {
        if (row && measure(row + character) > width - 6) {
          rows.push(row.trimEnd());
          row = '';
        }
        row += character;
      }
      rows.push(row);
    }
    const w = Math.ceil(Math.max(12, ...rows.map(measure)) + 5);
    const h = Math.ceil(config.fontSize * (lineHeight * rows.length + .18));
    const invalid = !source || rows.length > 12 || rows.join('\n').length > 700 || w > width || h > height;
    return atPosition({ ...layer, rows, w: Math.min(w, width), h: Math.min(h, height), invalid }, x, y, width, height);
  }

  function paint(item, target) {
    const group = target.group().attr('transform', `translate(${item.x} ${item.y})`);
    if (item.blendMode && item.blendMode !== 'normal') group.node.style.mixBlendMode = item.blendMode;
    if (item.kind === 'text') {
      const { fontFamily, fontSize, color } = item.config;
      item.rows.forEach((row, index) => group.plain(row).attr({
        x: 0, y: fontSize * (.91 + index * lineHeight), 'font-family': fonts[fontFamily],
        'font-size': fontSize, 'font-weight': 400, fill: color, 'xml:space': 'preserve',
      }));
      return;
    }
    const { fill: color, stroke: ink, strokeWidth: weight } = shapeStyle(item);
    const { kind, w, h, points } = item;
    let shape;
    if (kind === 'rect') shape = group.rect(w, h);
    else if (kind === 'ellipse') shape = group.ellipse(w, h);
    else if (kind === 'line') shape = group.line(...points[0], ...points[1]);
    else shape = group.path(pathData(points));
    shape.attr({ fill: color, stroke: ink, 'stroke-width': weight, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  }

  function paintLayers() {
    artwork.clear();
    overlay.clear();
    layers.forEach(layer => paint(layer, artwork));
    if (gesture?.preview) paint(gesture.preview, overlay);
    const item = layerFrame(selectedLayer());
    if (item) overlay.rect(Math.max(1, item.w) + 8, Math.max(1, item.h) + 8).move(item.x - 4, item.y - 4).attr({
      class: 'vector-canvas-selection', fill: 'none', 'vector-effect': 'non-scaling-stroke',
    });
  }

  function updateControls(sync = false) {
    const item = selectedLayer();
    const kind = tool === 'select' ? item?.kind : tool;
    paper.dataset.tool = tool;
    root.setAttribute('aria-busy', String(busy));
    for (const [key, button] of toolButtons) {
      button.setAttribute('aria-pressed', String(tool === key));
      button.disabled = busy;
    }
    const availableLayers = [...existingLayers, ...layers];
    layerField.hidden = availableLayers.length === 0;
    const key = availableLayers.map(layer => layer.id).join(',');
    if (key !== layerListKey) {
      layerListKey = key;
      selection.replaceChildren(element('option', { value: '', textContent: t('未选择', 'No selection') }),
        ...availableLayers.map((layer, index) => element('option', {
          value: layer.id, textContent: layer.label || `${tools[layer.kind]} ${index - existingLayers.length + 1}`,
        })));
    }
    selection.value = item?.id ?? '';
    selection.disabled = busy;
    blendField.hidden = tool !== 'select' || !item || item.id === 'palette';
    fitField.hidden = tool !== 'select' || !item?.image;
    blendMode.value = item ? appearance(item).blendMode : 'normal';
    fit.value = item?.image ? appearance(item).fit : 'contain';
    blendMode.disabled = fit.disabled = busy;
    textOptions.hidden = kind !== 'text';
    shapeOptions.hidden = !kind || kind === 'text';
    fillOptions.hidden = !hasFill(kind);
    if (sync && kind === 'text') {
      const config = item?.config ?? textDefaults;
      text.value = config.text;
      family.value = config.fontFamily;
      fontSize.value = config.fontSize;
      textColor.value = config.color;
    } else if (sync && kind) {
      const config = item?.config ?? shapeDefaults;
      stroke.value = config.stroke;
      strokeWidth.value = config.strokeWidth;
      solid.checked = config.solid;
      fill.value = config.fill;
    }
    for (const input of [text, family, fontSize, textColor, stroke, strokeWidth, solid]) input.disabled = busy;
    fill.disabled = busy || !solid.checked;
    undo.disabled = busy || history.length === 0;
    remove.disabled = busy || !item || Boolean(item.node);
    const invalid = layers.some(layer => layer.invalid);
    save.disabled = busy || (!layers.length && !layerEdits.size) || invalid;
    save.textContent = busy ? t('正在加入…', 'Adding…') : t('加入草稿', 'Add to draft');
    message.dataset.error = String(Boolean(error || invalid || previewError));
    message.textContent = error || previewError || (invalid ? t('请补全文字，或调整内容与字号以放入海报。', 'Enter text that fits on the poster, or reduce its size.')
      : saved ? t('已加入海报草稿。', 'Added to the poster draft.')
      : tool === 'text' ? t('点击海报放置文字。', 'Click the poster to place text.')
      : tool !== 'select' ? t('在海报上拖动绘制。', 'Drag on the poster to draw.')
      : item?.node ? ''
      : layers.length ? t('拖动图层调整位置。', 'Drag a layer to move it.')
      : existingLayers.length ? t('选择一个图层以编辑属性。', 'Select a layer to edit its properties.')
      : t('选择文字或图形工具开始。', 'Choose a text or drawing tool.'));
  }

  function checkpoint() {
    history = [...history.slice(-39), { layers, selected, layerEdits }];
    error = '';
    saved = false;
  }

  function choose(next) {
    tool = next;
    if (next !== 'select') selected = undefined;
    error = '';
    saved = false;
    updateControls(true);
    paintLayers();
  }

  function batchFits(nextLayers, nextEdits) {
    if (nextLayers.length + nextEdits.size <= 30 && canvasCalls(nextLayers, nextEdits, width, height).length <= 12) return true;
    error = t('这批图层已满，请先加入草稿。', 'Add this batch to the draft before editing more layers.');
    updateControls(true);
    return false;
  }

  function append(layer) {
    const item = { ...layer, id: `staged:${++nextId}` };
    const updated = [...layers, item];
    if (!batchFits(updated, layerEdits)) return;
    checkpoint();
    layers = updated;
    selected = item.id;
    choose('select');
  }

  function replace(item) {
    layers = layers.map(layer => layer.id === item.id ? item : layer);
    paintLayers();
    updateControls();
  }

  function undoChange() {
    if (!history.length || busy || gesture) return;
    ({ layers, selected, layerEdits } = history.pop());
    paintExistingStyles();
    choose('select');
  }

  function deleteLayer() {
    const item = selectedLayer();
    if (!item || item.node || busy || gesture) return;
    checkpoint();
    layers = layers.filter(layer => layer.id !== selected);
    selected = undefined;
    choose('select');
  }

  const toolButtons = new Map(Object.entries(tools).map(([kind, label]) => [kind, control(label)]));
  for (const [kind, button] of toolButtons) {
    toolbar.append(button);
    listen(button, 'click', () => { if (!busy && !gesture) choose(kind); });
  }
  listen(undo, 'click', undoChange);
  listen(remove, 'click', deleteLayer);
  listen(selection, 'change', () => { selected = selection.value || undefined; choose('select'); });

  function setAppearance(key, value) {
    const item = selectedLayer();
    if (!item || busy || gesture || appearance(item)[key] === value) return;
    if (!item.node) {
      checkpoint();
      replace({ ...item, [key]: value });
      return;
    }
    const edits = new Map(layerEdits);
    const changes = { ...edits.get(item.id), [key]: value };
    if (value === item[key]) delete changes[key];
    if (Object.keys(changes).length) edits.set(item.id, changes);
    else edits.delete(item.id);
    if (!batchFits(layers, edits)) return;
    checkpoint();
    layerEdits = edits;
    paintExistingStyles();
    updateControls();
  }
  listen(blendMode, 'change', () => setAppearance('blendMode', blendMode.value));
  listen(fit, 'change', () => setAppearance('fit', fit.value));

  let textCheckpoint = false;
  listen(text, 'focus', () => { textCheckpoint = false; });
  function updateText(fieldName, value) {
    const item = selectedLayer();
    if (item?.kind !== 'text') { textDefaults = { ...textDefaults, [fieldName]: value }; return; }
    if (fieldName !== 'text' || !textCheckpoint) checkpoint();
    if (fieldName === 'text') textCheckpoint = true;
    replace(textLayout({ ...item, config: { ...item.config, [fieldName]: value } }));
  }
  listen(text, 'input', () => updateText('text', text.value));
  listen(family, 'change', () => updateText('fontFamily', family.value));
  listen(fontSize, 'change', () => {
    const value = clamp(fontSize.valueAsNumber || 38, 6, 200);
    fontSize.value = value;
    updateText('fontSize', value);
  });
  listen(textColor, 'change', () => updateText('color', textColor.value));

  function updateShape(fieldName, value) {
    const item = selectedLayer();
    if (!item || item.kind === 'text') {
      shapeDefaults = { ...shapeDefaults, [fieldName]: value };
      updateControls();
      return;
    }
    checkpoint();
    replace({ ...item, config: { ...item.config, [fieldName]: value } });
  }
  listen(stroke, 'change', () => updateShape('stroke', stroke.value));
  listen(strokeWidth, 'change', () => {
    const value = clamp(strokeWidth.valueAsNumber || 4, 1, 40);
    strokeWidth.value = value;
    updateShape('strokeWidth', value);
  });
  listen(solid, 'change', () => updateShape('solid', solid.checked));
  listen(fill, 'change', () => updateShape('fill', fill.value));

  function canvasPoint(event) {
    const matrix = drawing.node.getScreenCTM();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [clamp(round(point.x), 0, width), clamp(round(point.y), 0, height)];
  }

  function hitLayer(x, y) {
    const hit = layer => {
      const frame = layerFrame(layer);
      return frame && x >= frame.x - 6 && x <= frame.x + frame.w + 6 && y >= frame.y - 6 && y <= frame.y + frame.h + 6;
    };
    return layers.findLast(hit) ?? existingLayers.findLast(hit);
  }

  listen(drawing.node, 'pointerdown', (event) => {
    if (busy || gesture || event.button !== 0 || !event.isPrimary) return;
    const [x, y] = canvasPoint(event);
    drawing.node.focus({ preventScroll: true });
    event.preventDefault();
    if (tool === 'text') {
      append(textLayout({ kind: 'text', x, y, config: textDefaults }));
      return;
    }
    if (tool === 'select') {
      const target = hitLayer(x, y);
      selected = target?.id;
      updateControls(true);
      paintLayers();
      if (!target || target.node) return;
      gesture = { pointerId: event.pointerId, start: [x, y], item: target, before: layers };
    } else {
      gesture = { pointerId: event.pointerId, kind: tool, start: [x, y], points: [[x, y]] };
    }
    drawing.node.setPointerCapture(event.pointerId);
  });

  function drag(event, finish = false) {
    if (gesture?.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    const { start, item, kind } = gesture;
    if (item) {
      const moved = atPosition(item, item.x + point[0] - start[0], item.y + point[1] - start[1], width, height);
      layers = layers.map(layer => layer.id === item.id ? moved : layer);
    } else {
      if (kind === 'path') {
        const last = gesture.points.at(-1);
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= (finish ? .2 : 2)) {
          if (gesture.points.length >= 128) gesture.points = gesture.points.filter((_, index) => index % 2 === 0);
          gesture.points.push(point);
        }
      } else gesture.points = [start, point];
      if (gesture.points.length >= 2) gesture.preview = shapeLayer(kind, gesture.points, shapeDefaults);
    }
    if (!finish) paintLayers();
  }

  listen(drawing.node, 'pointermove', drag);
  listen(drawing.node, 'pointerup', (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    drag(event, true);
    const { item, before, preview } = gesture;
    gesture = undefined;
    if (item) {
      const moved = selectedLayer();
      if (moved.x !== item.x || moved.y !== item.y) {
        const after = layers;
        layers = before;
        checkpoint();
        layers = after;
      }
    } else if (preview && (hasFill(preview.kind) ? preview.w >= 2 && preview.h >= 2 : Math.hypot(preview.w, preview.h) >= 2)) append(preview);
    paintLayers();
    updateControls();
  });

  function cancelDrag(event) {
    if (gesture?.pointerId !== event.pointerId) return;
    layers = gesture.before ?? layers;
    gesture = undefined;
    paintLayers();
    updateControls();
  }
  listen(drawing.node, 'pointercancel', cancelDrag);
  listen(drawing.node, 'lostpointercapture', cancelDrag);

  listen(root, 'keydown', (event) => {
    if (busy || gesture || event.target.closest('input,textarea,select')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoChange();
      return;
    }
    if (event.target !== drawing.node) return;
    const item = selectedLayer();
    const direction = { ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1] }[event.key];
    if (item && !item.node && direction) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      checkpoint();
      replace(atPosition(item, item.x + direction[0] * step, item.y + direction[1] * step, width, height));
    } else if (item && !item.node && ['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault();
      deleteLayer();
    } else if (event.key === 'Enter' && tool !== 'select') {
      event.preventDefault();
      const x = round(width * .38), y = round(height * .43);
      if (tool === 'text') append(textLayout({ kind: 'text', x, y, config: textDefaults }));
      else {
        const end = [round(width * .63), round(height * .56)];
        const points = tool === 'path' ? [[x, y], [round(width * .5), round(height * .39)], end] : [[x, y], end];
        append(shapeLayer(tool, points, shapeDefaults));
      }
    }
  });

  listen(save, 'click', async () => {
    if (save.disabled || gesture) return;
    busy = true;
    error = '';
    updateControls();
    try {
      const result = await onSave(canvasCalls(layers, layerEdits, width, height));
      if (result === false) throw new Error(t('未能加入草稿，请重试。', 'Could not add to the draft. Try again.'));
      for (const layer of existingLayers) Object.assign(layer, appearance(layer));
      layerEdits = new Map();
      layers = [];
      history = [];
      selected = undefined;
      tool = 'select';
      saved = true;
    } catch (failure) {
      error = failure?.message || t('未能加入草稿，请重试。', 'Could not add to the draft. Try again.');
    } finally {
      busy = false;
      if (!events.signal.aborted) { paintLayers(); updateControls(true); }
    }
  });

  if (previewUrl) {
    const url = new URL(previewUrl, location.href);
    if (url.origin === location.origin) {
      const frame = element('iframe', { title: t('海报预览', 'Poster preview'), tabIndex: -1, inert: true });
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('aria-hidden', 'true');
      listen(frame, 'load', () => usePoster(frame));
      frame.src = url.href;
      paper.prepend(frame);
    }
  }
  updateControls(true);
  return () => { events.abort(); root.remove(); };
}
