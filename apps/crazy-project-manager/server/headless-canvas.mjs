import { Defs, Dom, Mask, withWindow } from '@svgdotjs/svg.js';
import { DOMImplementation, Element, Node, XMLSerializer } from '@xmldom/xmldom';

const svgNamespace = 'http://www.w3.org/2000/svg';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const serializer = new XMLSerializer();

export function onSvgCanvas(draw) {
  const document = new DOMImplementation().createDocument(svgNamespace, 'svg', null);
  // SVG.js uses a DOM for SVG nodes. No browser canvas or font measurement is needed.
  return withWindow({ document, Node, SVGElement: Element }, () => draw(new Dom(document.documentElement), new Defs()));
}

export const svgMarkup = element => serializer.serializeToString(element.node);

export function addCanvasText(container, text, x, y) {
  const element = container.element('text', { x, y });
  element.attr('xml:space', 'preserve', xmlNamespace);
  element.node.textContent = text;
  return element;
}

export function addCanvasShape(container, layer, paint = {}) {
  const { shape, x = 0, y = 0, w, h, viewWidth, viewHeight } = layer;
  let name = shape;
  let geometry;
  switch (shape) {
    case 'rect':
      geometry = { x, y, width: w, height: h, rx: Math.min(layer.style?.radius ?? 0, w / 2, h / 2) };
      break;
    case 'ellipse':
      geometry = { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
      break;
    case 'path':
      geometry = { d: layer.d };
      break;
    case 'line': {
      const [[x1, y1], [x2, y2]] = layer.points ?? [[0, viewHeight / 2], [viewWidth, viewHeight / 2]];
      geometry = { x1, y1, x2, y2 };
      break;
    }
    case 'triangle':
      name = 'polygon';
      geometry = { points: [ [w / 2, 0], [w, h], [0, h] ] };
      break;
    case 'star':
      name = 'polygon';
      geometry = { points: Array.from({ length: 10 }, (_, index) => {
        const angle = index * Math.PI / 5 - Math.PI / 2;
        const radius = index % 2 ? .21 : .5;
        return [w * (.5 + Math.cos(angle) * radius), h * (.5 + Math.sin(angle) * radius)];
      }) };
      break;
    case 'polygon':
    case 'polyline':
      geometry = { points: layer.points };
      break;
    default:
      throw new Error('无法绘制这个 SVG 图形。');
  }
  if (geometry.points) geometry.points = geometry.points.map(point => point.join(',')).join(' ');
  const attributes = Object.fromEntries(Object.entries({ ...geometry, ...paint }).filter(([, value]) => value != null));
  return container.element(name, attributes);
}

export function addLayerGradient(definitions, layer) {
  const { type, stops, ...coordinates } = layer.gradient;
  const id = 'studio-gradient.' + layer.id;
  const gradient = definitions.gradient(type, target => {
    for (const stop of stops) target.stop(stop.offset, stop.color, stop.opacity);
  });
  return gradient.attr({ id, gradientUnits: 'objectBoundingBox', ...coordinates }).url();
}

export function addLayerMask(definitions, layer) {
  const id = 'studio-mask.' + layer.id;
  const mask = definitions.put(new Mask()).attr({
    id, x: 0, y: 0, width: layer.w, height: layer.h,
    maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', 'mask-type': 'luminance'
  });
  const cutout = layer.mask.mode === 'cutout';
  if (cutout) addCanvasShape(mask, { shape: 'rect', w: layer.w, h: layer.h }, { fill: '#fff' });
  const { viewWidth, viewHeight, parts } = layer.mask;
  const artwork = viewWidth ? mask.element('g', { transform: `scale(${layer.w / viewWidth} ${layer.h / viewHeight})` }) : mask;
  const color = cutout ? '#000' : '#fff';
  for (const part of parts) {
    const open = part.shape === 'line' || part.shape === 'polyline';
    const strokeWidth = part.style?.strokeWidth ?? (open ? 2 : 0);
    addCanvasShape(artwork, part, {
      fill: open ? 'none' : color, stroke: strokeWidth ? color : 'none', 'stroke-width': strokeWidth,
      opacity: part.style?.opacity, 'fill-rule': part.style?.fillRule,
      'stroke-linecap': part.style?.strokeLinecap, 'stroke-linejoin': part.style?.strokeLinejoin
    });
  }
  return 'url(#' + id + ')';
}
