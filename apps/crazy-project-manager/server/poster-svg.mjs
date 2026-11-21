import jsQR from 'jsqr';
import makeQR from 'qrcode-generator';
import { defaultLogoColor, getElement, palettes, theme } from './poster.mjs';
import { addCanvasShape, addCanvasText, addLayerGradient, addLayerMask, onSvgCanvas, svgMarkup } from './headless-canvas.mjs';
import { posterFonts } from './poster-fonts.mjs';
import { paperUnitsPerMm, posterPaper } from './poster-paper.mjs';
import { layerBlendModes } from './design-tools.mjs';

export const posterFontFamilies = 'MuseumPoster, MuseumPosterCJK, Microsoft YaHei, Noto Sans CJK SC, sans-serif';
// These glyphs are present in both small font subsets bundled with the SVG.
const bundledGlyphs = new Set('·–—、。《》「」东主交会作免入分划别前办动北南取合名周场城基夜天宾展市常年开扫把报收放新日旧时晚月未术每活消游特眠码空约给美联至艺西览计设费金门间须预馆！（），：；？');
const cjkCharacters = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
const qrCache = new Map();

export function posterFontStyles(regular, bold) {
  return [regular, bold].map((font, index) => (
    `@font-face{font-family:MuseumPoster;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:${index === 0 ? 400 : 800}}`
  )).join('');
}

export function designFontStyles(scene, base64Font) {
  const needed = new Set(scene.elements.filter(layer => !layer.hidden).map(layer => layer.style?.fontFamily));
  return Object.entries(posterFonts).filter(([id]) => needed.has(id)).flatMap(([, font]) => font.faces.map(face =>
    fontFace(font.name, base64Font(face.file), face))).join('');
}

export function usedDesignFonts(svg) {
  return Object.values(posterFonts).filter(({ name, faces }) => faces.length && (svg.includes(`font-family="${name},`) ||
    svg.includes(`font-family="${name}"`) || svg.includes(`@font-face{font-family:${name};`))).flatMap(font => font.faces.map(face => face.file));
}

function fontFace(name, base64, { weight = 400, style = 'normal' } = {}) {
  return `@font-face{font-family:${name};src:url(data:font/ttf;base64,${base64}) format('truetype');font-weight:${weight};font-style:${style}}`;
}

export function embedCjkFallback(svg, base64Font) {
  if (!needsFontFallback(svg, cjkCharacters)) return svg;
  return svg.replace('</style>', `${fontFace('MuseumPosterCJK', base64Font('museum-cjk.ttf'))}</style>`);
}

function letteringTypeface(style, defaultWeight, fonts) {
  const id = style?.fontFamily;
  const font = Object.hasOwn(posterFonts, id) ? posterFonts[id] : null;
  const family = id === 'sans' ? fonts : font && `${font.name}, MuseumPosterCJK, MuseumPoster, ${font.generic}`;
  const weight = style?.fontWeight ?? defaultWeight;
  if (!font?.staticFaces) return { family, weight, style: style?.fontStyle };

  const slant = style?.fontStyle ?? 'normal';
  const matching = font.faces.filter(face => (face.style ?? 'normal') === slant);
  const candidates = matching.length ? matching : font.faces;
  const target = weight ?? 400;
  const chosen = candidates.reduce((best, face) => Math.abs(face.weight - target) < Math.abs(best.weight - target) ? face : best);
  return { family, weight: chosen.weight, style: chosen.style ?? 'normal' };
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function attr(key, value) {
  return value == null ? '' : ` ${key}="${xml(value)}"`;
}

function paintAttributes(style, { fill, stroke, strokeWidth } = {}) {
  return {
    fill: style?.fill ?? fill, stroke: style?.stroke ?? stroke, 'stroke-width': style?.strokeWidth ?? strokeWidth,
    'fill-opacity': style?.fillOpacity, 'stroke-opacity': style?.strokeOpacity, 'fill-rule': style?.fillRule,
    'stroke-linecap': style?.strokeLinecap, 'stroke-linejoin': style?.strokeLinejoin
  };
}

function paint(style, defaults) {
  return Object.entries(paintAttributes(style, defaults)).map(([name, value]) => attr(name, value)).join('');
}

function displayedText(content, transform) {
  const text = String(content ?? '');
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|[^\p{L}\p{M}\p{N}'’])(\p{L})/gu, (_, boundary, initial) => boundary + initial.toUpperCase());
  return text;
}

function textBlock(layer, content, { fill, size, weight, spacing, leading = 1.12, baseline = .91, fonts, align = 'left', canvas }) {
  const style = layer.style ?? {};
  const rows = displayedText(content, style.textTransform).split('\n');
  const fontSize = style.fontSize ?? size;
  const lineHeight = fontSize * (style.lineHeight ?? leading);
  const textAlign = style.textAlign ?? align;
  const [x, anchor] = textAlign === 'center' ? [layer.w / 2, 'middle'] : textAlign === 'right' ? [layer.w, 'end'] : [0, 'start'];
  const freeHeight = Math.max(0, layer.h - (rows.length - 1) * lineHeight - fontSize);
  const y = (style.verticalAlign === 'bottom' ? freeHeight : style.verticalAlign === 'middle' ? freeHeight / 2 : 0) + fontSize * baseline;
  const typeface = letteringTypeface(style, weight, fonts);
  const lettering = attr('font-size', fontSize) + attr('font-weight', typeface.weight) + attr('font-family', typeface.family)
    + attr('font-style', typeface.style) + attr('text-decoration', style.textDecoration) + attr('letter-spacing', style.letterSpacing ?? spacing)
    + attr('text-anchor', anchor);
  const text = rows.map((row, index) => {
    const baselineY = y + index * lineHeight;
    return canvas ? svgMarkup(addCanvasText(canvas, row, x, baselineY))
      : `<text x="${x}" y="${baselineY}" xml:space="preserve">${xml(row)}</text>`;
  }).join('');
  return `<g${paint({ ...style, fill: style.textColor ?? style.fill }, { fill })}${lettering}>${text}</g>`;
}

function rasterArtwork(layer, defaultFit = 'contain') {
  if (!/^data:image\/png;base64,iVBORw0KGgo/.test(layer.image ?? '')) throw new Error('请先加载本项目的图片素材。');
  const mode = { contain: 'xMidYMid meet', cover: 'xMidYMid slice', fill: 'none' }[layer.fit ?? defaultFit];
  return `<image width="${layer.w}" height="${layer.h}" href="${xml(layer.image)}" preserveAspectRatio="${mode}"/>`;
}

function shapeNode(canvas, layer, colors, attributes = {}) {
  const { shape, style } = layer;
  const open = shape === 'line' || shape === 'polyline';
  const ink = paintAttributes(style, { fill: open ? 'none' : colors.accent,
    stroke: open ? layer.gradientFill ?? colors.accent : undefined, strokeWidth: open ? 1.6 : undefined });
  if (open && layer.gradientFill) {
    ink.fill = 'none';
    ink.stroke = layer.gradientFill;
  }
  return svgMarkup(addCanvasShape(canvas, layer, { ...ink, ...attributes }));
}

function shapeViewport({ w, h, viewWidth, viewHeight }, content) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${viewWidth} ${viewHeight}" preserveAspectRatio="none" overflow="hidden">${content}</svg>`;
}

function shapeArtwork(layer, colors, canvas) {
  const content = shapeNode(canvas, { ...layer, x: 0, y: 0 }, colors);
  return ['path', 'line', 'polygon', 'polyline'].includes(layer.shape) ? shapeViewport(layer, content) : content;
}

function vectorArtwork(layer, colors, canvas) {
  const content = layer.parts.map(part => {
    const style = { ...layer.style, ...part.style };
    if (layer.gradientFill && part.style?.fill !== 'none' && part.style?.fill !== 'transparent') style.fill = layer.gradientFill;
    const attributes = { id: `vector.${layer.id}.${part.id}`, 'data-vector-part': part.id, opacity: part.style?.opacity };
    return shapeNode(canvas, { ...part, style, gradientFill: layer.gradientFill }, colors, attributes);
  }).join('');
  return shapeViewport(layer, content);
}

function customArtwork(layer, colors, fonts, canvas) {
  if (layer.type === 'shape') return shapeArtwork(layer, colors, canvas);
  if (layer.type === 'vector') return vectorArtwork(layer, colors, canvas);
  if (layer.type === 'image') return rasterArtwork(layer);
  return `<svg width="${layer.w}" height="${layer.h}" overflow="hidden">${textBlock(layer, layer.text, { fill: colors.accent, size: 24, weight: 400, fonts, canvas })}</svg>`;
}

function paletteArtwork({ bg, accent, fine }, project, layer) {
  const background = `<rect width="${layer.w}" height="${layer.h}" fill="${xml(layer.style?.fill ?? bg)}"/>`;
  if (layer.decorations === 'none') return background;
  return `${background}
    <g transform="scale(${layer.w / theme.width} ${layer.h / theme.height})">
    <g fill="none" stroke="${fine}" stroke-width=".7" opacity=".27">
      <path d="M30 0v800M570 0v800M0 74h600M0 668h600"/>
      <circle cx="300" cy="464" r="210"/><circle cx="300" cy="464" r="156"/>
      <path d="M0 464h600m-300-235v470" stroke-dasharray="3 8"/>
    </g>
    ${project ? '' : `<g fill="${accent}" text-anchor="end" letter-spacing="1.7">
      <text x="560" y="124" font-size="13">A NIGHT</text>
      <text x="560" y="142" font-size="13">TO WANDER.</text>
      <text x="560" y="164" font-size="9">特别夜间开放计划</text>
    </g>`}
    </g>`;
}

function visualArtwork(layer, { bg, accent, fine }) {
  if (layer.asset === 'uploaded') {
    return rasterArtwork(layer, 'cover');
  }
  const radialLines = [];
  for (let index = 0; index < 48; index++) {
    const angle = index * Math.PI / 24;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    radialLines.push(`M${(x * 177).toFixed(1)} ${(y * 99).toFixed(1)}L${(x * 227).toFixed(1)} ${(y * 148).toFixed(1)}`);
  }
  return `<g transform="scale(${layer.w / 530} ${layer.h / 309})">
    <g transform="translate(265 154) rotate(-27)" fill="none">
      <ellipse rx="205" ry="124" stroke="${bg}" stroke-width="64"/>
      <ellipse rx="201" ry="122" stroke="${xml(layer.gradientFill ?? 'url(#museum-ribbon)')}" stroke-width="52"/>
      <ellipse rx="205" ry="134" stroke="${accent}" stroke-width="1.25" opacity=".66"/>
      <ellipse rx="187" ry="105" stroke="${fine}"/>
      <path d="M-201 0c0-67 90-122 201-122s201 55 201 122" stroke="${accent}" stroke-width="1.8"/>
      <path d="${radialLines.join(' ')}" stroke="${bg}" opacity=".47"/>
    </g>
    <g stroke="${accent}" fill="none">
      <path d="M438 24v32m-16-16h32M55 256v24m-12-12h24" stroke-width="1.3"/>
      <circle cx="438" cy="40" r="11" stroke-width=".7"/><circle cx="84" cy="62" r="3"/>
    </g>
  </g>`;
}

function titleArtwork(layer, { accent }, _project, fonts) {
  if (layer.style) return textBlock(layer, layer.text, { fill: accent, size: layer.size, weight: layer.weight, spacing: layer.size * -.055, leading: 1.08, fonts });
  const lines = layer.text.split('\n').map((line, index) => (
    `<text x="0" y="${layer.size * (.91 + index * 1.08)}">${xml(line)}</text>`
  ));
  return `<g fill="${accent}" font-size="${layer.size}" font-weight="${layer.weight}" letter-spacing="${layer.size * -.055}">${lines.join('')}</g>`;
}

function logoArtwork(layer, colors, project, fonts) {
  const approved = layer.asset === theme.assets.approvedLogo;
  const color = layer.style?.fill ?? defaultLogoColor(layer.asset, colors);
  const logoFont = letteringTypeface(layer.style, 800, fonts);
  const sign = approved ? 'M14 4 27 18 14 32 1 18Zm0 4v20m-8-10h16' : 'M3 8h23v20H3Zm3 10h17m-9-7v14';
  return `<g fill="${color}" transform="scale(${layer.w / 132} ${layer.h / 38})" data-asset="${layer.asset}"${attr('font-family', logoFont.family)}${attr('font-style', logoFont.style)}>
    <path d="${sign}" stroke="${layer.style?.stroke ?? color}" stroke-width="${layer.style?.strokeWidth ?? 1.55}" fill="none"/>
    ${project ? `<text x="36" y="22" font-size="${Math.min(15, 92 / Math.max(1, Array.from(project.facts.organizer).length))}" font-weight="${logoFont.weight}">${xml(displayedText(project.facts.organizer, layer.style?.textTransform))}</text>` : `
    <text x="36" y="17" font-size="15" font-weight="${logoFont.weight}" letter-spacing=".65">未眠美术馆</text>
    <text x="36" y="30" font-size="7.6" letter-spacing=".43">${xml(displayedText('SLEEPLESS ART MUSEUM', layer.style?.textTransform))}</text>`}
  </g>`;
}

function infoArtwork(layer, { accent, fine }, project, fonts) {
  if (layer.style) {
    const lines = [layer.date, layer.hours, [layer.venue, layer.gate].filter(Boolean).join(' · ')].filter(Boolean);
    return textBlock(layer, lines.join('\n'), { fill: accent, size: layer.size, weight: 400, leading: 1.26, fonts });
  }
  if (project) {
    const lines = [[layer.date, 1.25], [layer.hours, 1], [[layer.venue, layer.gate].filter(Boolean).join(' · '), .94]].filter(([value]) => value);
    return `<g fill="${accent}">${lines.map(([value, scale], index) => (
      `<text y="${layer.size * (1.3 + 1.24 * index)}" font-size="${layer.size * scale}">${xml(value)}</text>`
    )).join('')}</g>`;
  }
  return `<g fill="${accent}">
    <text x="0" y="${layer.size * 1.37}" font-size="${layer.size * 1.4}" font-weight="800">${xml(layer.date)}</text>
    <text x="0" y="${layer.size * 2.64}" font-size="${layer.size}">${xml(layer.hours)}</text>
    <text x="0" y="${layer.size * 3.93}" font-size="${layer.size * .92}" fill="${fine}">${xml(layer.venue)} · ${xml(layer.gate)}</text>
  </g>`;
}

function stickerArtwork(layer, { accent, bg, monochrome }, _project, fonts) {
  const large = layer.treatment === 'yellow' && layer.h >= 77;
  const position = layer.w / 2;
  const yellow = layer.treatment === 'yellow' || layer.treatment === 'callout';
  const badgeFill = monochrome ? accent : '#f3dc78';
  const badgeText = monochrome ? bg : '#28261b';
  if (layer.style) {
    const { style } = layer;
    const badge = yellow ? `<rect width="${layer.w}" height="${layer.h}" rx="${style.radius ?? (large ? 7 : 3)}"${paint(style, { fill: badgeFill })}/>` : '';
    const styled = { ...layer, style: { verticalAlign: 'middle', ...style, fill: yellow ? style.textColor ?? badgeText : style.fill, stroke: yellow ? undefined : style.stroke } };
    const value = large ? layer.text.split(/\s*·\s*/).join('\n') : layer.text;
    return badge + textBlock(styled, value, { fill: accent, size: layer.size, weight: yellow ? 800 : 400, align: 'center', leading: 1.01, fonts });
  }
  const background = yellow ? `<rect width="${layer.w}" height="${layer.h}" rx="${large ? 7 : 3}" fill="${badgeFill}"/>` : '';
  const lines = large ? layer.text.split(/\s*·\s*/) : [layer.text];
  const lineHeight = layer.size * 1.01;
  const start = layer.h / 2 - (lines.length - 1) * lineHeight / 2 + layer.size * .34;
  return `${background}<g fill="${yellow ? badgeText : accent}" text-anchor="middle" font-size="${layer.size}" font-weight="${yellow ? 800 : 400}">
    ${lines.map((line, index) => `<text x="${position}" y="${start + index * lineHeight}">${xml(line)}</text>`).join('')}
  </g>`;
}

function qrModules(url) {
  if (qrCache.has(url)) return qrCache.get(url);
  const qr = makeQR(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const commands = [];
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (qr.isDark(y, x)) commands.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  const result = { span: count + 8, path: commands.join('') };
  if (qrCache.size >= 96) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(url, result);
  return result;
}

function qrArtwork(layer, { accent, monochrome }) {
  if (!layer.url) return '';
  const { span, path } = qrModules(layer.url);
  const scaleX = layer.w / span;
  const scaleY = layer.h / span;
  const caption = layer.h >= 48 ? `<text x="${layer.w / 2}" y="${layer.h + 14}" font-size="10" text-anchor="middle" fill="${accent}">扫码预约</text>` : '';
  return `<a href="${xml(layer.url)}" aria-label="打开预约页面">
    <g transform="scale(${scaleX} ${scaleY})" shape-rendering="crispEdges">
      <rect width="${span}" height="${span}" fill="${monochrome ? '#ffffff' : '#fbfcf7'}"/><path d="${path}" fill="${monochrome ? '#000000' : '#18211c'}"/>
    </g>
    ${caption}
  </a>`;
}

const artworks = {
  palette: (layer, colors, project) => paletteArtwork(colors, project, layer),
  visual: visualArtwork,
  title: titleArtwork,
  tagline: (layer, colors, _project, fonts) => layer.style
    ? textBlock(layer, layer.text, { fill: colors.accent, size: layer.size, spacing: 3, fonts })
    : `<text y="${layer.size}" font-size="${layer.size}" letter-spacing="3" fill="${colors.accent}">${xml(layer.text)}</text>`,
  logo: logoArtwork,
  info: infoArtwork,
  credits: (layer, colors, _project, fonts) => layer.style
    ? textBlock(layer, layer.text, { fill: colors.fine, size: layer.size, fonts })
    : `<text y="${layer.size}" font-size="${layer.size}" fill="${colors.fine}">${xml(layer.text)}</text>`,
  qr: qrArtwork,
  sticker: stickerArtwork,
};

export function renderPosterSVG(scene, styles, fonts = posterFontFamilies) {
  const colors = palettes[getElement(scene, 'palette').preset];
  const title = xml(scene.project?.name ?? theme.name);
  const paper = scene.paper ? posterPaper(scene.paper) : null;
  if (paper && (paper.widthMm * paperUnitsPerMm !== scene.width || paper.heightMm * paperUnitsPerMm !== scene.height)) {
    throw new Error('The poster viewBox does not match its paper dimensions.');
  }
  return onSvgCanvas((canvas, definitions) => {
    const layers = scene.elements.map(layer => {
      const group = layer.group ? ` data-group="${xml(layer.group)}"` : '';
      const hidden = layer.hidden ? ' display="none"' : '';
      const rotation = layer.style?.rotation && layer.id !== 'palette' ? ` rotate(${layer.style.rotation} ${layer.w / 2} ${layer.h / 2})` : '';
      const gradientFill = layer.gradient ? addLayerGradient(definitions, layer) : null;
      const masked = layer.mask ? addLayerMask(definitions, layer) : null;
      const blend = layer.style?.blendMode;
      const compositing = blend !== 'normal' && layerBlendModes.includes(blend) ? attr('style', `mix-blend-mode:${blend}`) : '';
      const artworkLayer = blend !== undefined && Object.keys(layer.style).length === 1 ? { ...layer, style: undefined } : layer;
      const brush = gradientFill ? { ...layer, gradientFill, style: { ...layer.style, fill: gradientFill } } : artworkLayer;
      if (gradientFill && (layer.type === 'text' || ['title', 'tagline', 'info', 'credits'].includes(layer.id))) brush.style.textColor = gradientFill;
      const artwork = Object.hasOwn(artworks, layer.id) ? artworks[layer.id](brush, colors, scene.project, fonts) : customArtwork(brush, colors, fonts, canvas);
      return `<g id="${xml(layer.id)}" aria-label="${xml(layer.label)}" transform="translate(${layer.x} ${layer.y})${rotation}"${group}${hidden}${attr('opacity', layer.style?.opacity)}${attr('mask', masked)}${compositing}>${artwork}</g>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${paper ? `${paper.widthMm}mm` : scene.width}" height="${paper ? `${paper.heightMm}mm` : scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${title}活动海报" xml:lang="zh-CN">
  <title>${title}</title>
  <style>${styles}</style>
  <defs><linearGradient id="museum-ribbon" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="${colors.accent}"/><stop offset=".45" stop-color="${colors.ribbon}"/><stop offset="1" stop-color="${colors.bg}"/>
  </linearGradient></defs>
  ${definitions.node.hasChildNodes() ? svgMarkup(definitions) : ''}
  <g font-family="${fonts}">${layers.join('\n')}</g>
</svg>`;
  });
}

export function needsFontFallback(svg, characters) {
  const text = [...String(svg).matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(([, value]) => value).join('');
  return Array.from(text).some(character => !bundledGlyphs.has(character) && (characters ?? /[^\x20-\x7e]/).test(character));
}

function cropPixels(image, layer, scene) {
  const scaleX = image.width / scene.width;
  const scaleY = image.height / scene.height;
  const left = Math.max(0, Math.floor((layer.x - 3) * scaleX));
  const top = Math.max(0, Math.floor((layer.y - 3) * scaleY));
  const width = Math.min(image.width, Math.ceil((layer.x + layer.w + 3) * scaleX)) - left;
  const height = Math.min(image.height, Math.ceil((layer.y + layer.h + 3) * scaleY)) - top;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const rgba = image.pixels;
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * image.width + left) * 4;
    pixels.set(rgba.subarray(start, start + width * 4), row * width * 4);
  }
  return { pixels, width, height };
}

export function decodePosterQR(scene, readImage, reachable) {
  const layer = getElement(scene, 'qr');
  if (layer.hidden || !layer.url || layer.url !== scene.reservationUrl) return 'invalid';
  try {
    const crop = cropPixels(readImage(), layer, scene);
    const code = jsQR(crop.pixels, crop.width, crop.height, { inversionAttempts: 'dontInvert' });
    if (code?.data !== scene.reservationUrl) return 'invalid';
    const available = typeof reachable === 'function' ? reachable(code.data) : reachable;
    if (available === false) return 'invalid';
    return available === true ? 'verified' : 'pending';
  } catch {
    return 'pending';
  }
}
