import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canvasProgramTool, runCanvasProgram } from './canvas-program.mjs';
import { layerBlendModes } from './design-tools.mjs';
import { createInitialPoster } from './initial-poster.mjs';
import { applyPatch, createScene, getElement, verifyPosterPngBytes } from './poster.mjs';
import { enUsPosterFontPath } from './poster-fonts.mjs';
import { posterSVG, rasterizePoster, verifyPosterQR } from './poster-render.mjs';
import { reviewScene } from './poster-review.mjs';
import { projectTheme } from './project-theme.mjs';

const project = projectTheme(undefined, { topic: 'Cat Election', date: 'september 12', venue: 'north hall' });
const pathPart = { id: 'outline', shape: 'path', d: 'M8 12L65 45', style: { fill: 'none', stroke: '#252e45', strokeWidth: 4 } };

test('canvas accepts CSS font lists, renders letter case, and moves layers with either set syntax', () => {
  const start = createInitialPoster(project);
  const { scene } = runCanvasProgram(start, { commands: [
    { op: 'text', layers: [
      { id: 'title', style: { fontFamily: '"Helvetica Neue", Arial, sans-serif', textTransform: 'uppercase' } },
      { id: 'info', style: { fontFamily: 'Georgia, serif', textTransform: 'capitalize' } },
      { id: 'tag', x: 50, y: 325, w: 300, h: 50, text: 'CAST YOUR BALLOT', style: { fontFamily: 'Courier New, monospace', textTransform: 'lowercase' } },
    ] },
    { op: 'arrange', operations: [
      { op: 'set', id: 'title', x: 50, y: 75 },
      { id: 'info', set: { x: 45 }, y: 690 },
    ] },
  ] });
  const title = getElement(scene, 'title');
  const info = getElement(scene, 'info');
  const tag = getElement(scene, 'tag');
  assert.deepEqual([title.style.fontFamily, info.style.fontFamily, tag.style.fontFamily], ['sans', 'serif', 'mono']);
  assert.deepEqual([title.x, title.y, info.x, info.y], [50, 75, 45, 690]);
  assert.equal(title.text, getElement(start, 'title').text);
  assert.equal(info.venue, 'north hall');
  const svg = posterSVG(scene);
  for (const text of ['CAT', 'ELECTION', 'September 12', 'North Hall', 'cast your ballot']) assert.ok(svg.includes(`>${text}</text>`), text);
  const bitmap = rasterizePoster(svg);
  assert.deepEqual([bitmap.width, bitmap.height], [594, 840]);
  assert.throws(() => runCanvasProgram(start, { commands: [{ op: 'text', layers: [{ id: 'title', style: { fontFamily: 'url(https://example.test/font), serif' } }] }] }), /fontFamily/);
  assert.throws(() => runCanvasProgram(start, { commands: [{ op: 'arrange', operations: [{ op: 'set', id: 'title', x: 50, set: { x: 60 } }] }] }), /各出现了一次/);
});

test('canvas font options use different bundled faces and preserve Chinese fallback in SVG and PNG', () => {
  const start = createInitialPoster(project);
  const fontSchema = canvasProgramTool.function.parameters.properties.commands.items.properties.layers.items.properties.style.properties.fontFamily;
  for (const id of ['sans', 'serif', 'mono', 'condensed', 'display']) assert.match(fontSchema.description, new RegExp(`\\b${id}\\b`));
  function setTitle(fontFamily, fontStyle) {
    return runCanvasProgram(start, { commands: [{ op: 'text', layers: [{ id: 'title', style: { fontFamily, fontStyle, fontWeight: 800 } }] }] }).scene;
  }
  const condensed = setTitle('"Barlow Condensed", Arial', 'normal');
  const display = setTitle('DM Serif Display', 'italic');
  assert.equal(getElement(condensed, 'title').style.fontFamily, 'condensed');
  assert.equal(getElement(display, 'title').style.fontFamily, 'display');
  const condensedSvg = posterSVG(condensed);
  const displaySvg = posterSVG(display);
  assert.match(condensedSvg, /font-weight="700" font-family="Barlow Condensed,/);
  assert.match(displaySvg, /font-family="DM Serif Display,[^"]+" font-style="italic"/);
  assert.match(condensedSvg, /@font-face\{font-family:Barlow Condensed;src:url\(data:font\/ttf;base64,/);
  assert.match(displaySvg, /@font-face\{font-family:DM Serif Display;src:url\(data:font\/ttf;base64,/);
  assert.doesNotMatch(condensedSvg, /@font-face\{font-family:MuseumPosterCJK;/);
  const renders = [condensedSvg, displaySvg, posterSVG(setTitle('sans', 'normal'))].map(svg => rasterizePoster(svg).asPng());
  for (let i = 0; i < renders.length; i++) {
    for (let j = i + 1; j < renders.length; j++) assert.notDeepEqual(renders[i], renders[j]);
  }

  const mixed = runCanvasProgram(condensed, { commands: [{ op: 'text', layers: [
    { id: 'venue-note', x: 30, y: 420, w: 490, h: 65, text: '虹桥', style: { fontFamily: 'display', fontSize: 36 } },
  ] }] }).scene;
  const mixedSvg = posterSVG(mixed);
  assert.match(mixedSvg, /@font-face\{font-family:MuseumPosterCJK;src:url\(data:font\/ttf;base64,/);
  const baseline = rasterizePoster(condensedSvg).pixels;
  const withNote = rasterizePoster(mixedSvg).pixels;
  const glyphInk = baseline.subarray(600 * 420 * 4, 600 * 485 * 4).reduce((count, value, offset) =>
    count + Number(value !== withNote[600 * 420 * 4 + offset]), 0);
  assert.ok(glyphInk > 300, 'Chinese glyphs missing in the Latin display font still render');
});

test('the uploaded EN-US font remains an editable face and is embedded verbatim for export', () => {
  const start = createInitialPoster(project);
  const fontSchema = canvasProgramTool.function.parameters.properties.commands.items.properties.layers.items.properties.style.properties.fontFamily;
  assert.match(fontSchema.description, /en-us \(uploaded EN-US\.TTF/);
  const setFont = (fontFamily, fontWeight = 400, fontStyle = 'normal') => runCanvasProgram(start, { commands: [{ op: 'text', layers: [
    { id: 'bilingual', x: 40, y: 400, w: 500, h: 66, text: 'Find the ballot 项目海报',
      style: { fontFamily, fontWeight, fontStyle, fontSize: 40 } },
  ] }] }).scene;
  const original = readFileSync(new URL(`../dist${enUsPosterFontPath}`, import.meta.url));
  const selected = setFont('EN-US.TTF', 800, 'italic');
  assert.equal(getElement(selected, 'bilingual').style.fontFamily, 'en-us');
  assert.equal(getElement(setFont('SDK_US_Web'), 'bilingual').style.fontFamily, 'en-us');
  const svg = posterSVG(selected);
  assert.match(svg, /font-weight="400" font-family="SDK_US_Web, [^"]+" font-style="normal"/);
  assert.ok(svg.includes(`@font-face{font-family:SDK_US_Web;src:url(data:font/ttf;base64,${original.toString('base64')})`));
  assert.deepEqual(rasterizePoster(svg).pixels, rasterizePoster(posterSVG(setFont('en-us'))).pixels);
  assert.notDeepEqual(rasterizePoster(svg).pixels, rasterizePoster(posterSVG(setFont('sans'))).pixels);
  assert.throws(() => setFont('file:///other.ttf'), /fontFamily/);
});

test('paint blends two PNG layers and composes the result with opacity and a reveal mask', () => {
  const solid = fill => 'data:image/png;base64,' + rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`).asPng().toString('base64');
  const imageOperation = (id, image, x, y, w, h) => ({ op: 'add', element: { id, type: 'image', label: id, image, fit: 'fill', x, y, w, h } });
  const scene = runCanvasProgram(createInitialPoster(project), { commands: [{ op: 'arrange', operations: [
    imageOperation('base', solid('#40a060'), 120, 390, 170, 80), imageOperation('ink', solid('#c050e0'), 145, 410, 100, 40),
  ] }] }).scene;
  const paintLayer = (patch, base = scene) => runCanvasProgram(base, { commands: [{ op: 'paint', id: 'ink', ...patch }] }).scene;
  const pixel = (raster, x, y) => Array.from(raster.pixels.slice((y * raster.width + x) * 4, (y * raster.width + x + 1) * 4));
  const expected = {
    normal: [192, 80, 224], multiply: [48, 50, 84], screen: [208, 190, 236], overlay: [96, 125, 169],
    darken: [64, 80, 96], lighten: [192, 160, 224], 'hard-light': [161, 100, 216],
    'soft-light': [96, 138, 142], difference: [128, 80, 128], exclusion: [160, 140, 151],
  };
  const styleSchema = canvasProgramTool.function.parameters.properties.commands.items.properties.style.properties;
  assert.deepEqual(styleSchema.blendMode.enum, [...layerBlendModes, null]);
  for (const mode of layerBlendModes) {
    const svg = posterSVG(paintLayer({ style: { blendMode: mode } }));
    const raster = rasterizePoster(svg);
    assert.deepEqual(pixel(raster, 170, 430), [...expected[mode], 255], mode);
    if (mode === 'normal') assert.equal(svg, posterSVG(scene));
    else assert.match(svg, new RegExp(`<g id="ink"[^>]+style="mix-blend-mode:${mode}"`));
  }
  const blend = paintLayer({ style: { blendMode: 'multiply', opacity: .5 },
    mask: { mode: 'reveal', parts: [{ id: 'window', shape: 'rect', x: 0, y: 0, w: 45, h: 40 }] } });
  const masked = rasterizePoster(posterSVG(blend));
  assert.equal(masked.asPng().subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(pixel(masked, 170, 430), [56, 105, 90, 255]);
  assert.deepEqual(pixel(masked, 210, 430), [64, 160, 96, 255]);
  const reset = getElement(paintLayer({ style: { blendMode: null } }, blend), 'ink');
  assert.deepEqual(reset.style, { opacity: .5 });
  assert.throws(() => paintLayer({ style: { blendMode: 'screen;opacity:0' } }), /blendMode/);
});

test('draw resolves an empty visual placeholder to its own editable vector and leaves existing artwork alone', () => {
  const start = createInitialPoster(project);
  const original = getElement(start, 'visual');
  const { scene, patches } = runCanvasProgram(start, { commands: [{ op: 'draw', layer: { id: 'visual', parts: [pathPart] } }] });
  assert.equal(patches[0].element.id, 'visual-art');
  assert.deepEqual(getElement(scene, 'visual'), original);
  const art = getElement(scene, 'visual-art');
  assert.deepEqual([art.x, art.y, art.w, art.h], [original.x, original.y, original.w, original.h]);
  const updated = runCanvasProgram(scene, { commands: [{ op: 'draw', layer: { id: 'visual', partChanges: [{ op: 'set', id: 'outline', d: 'M4 10L81 60' }] } }] });
  assert.equal(getElement(updated.scene, 'visual-art').parts[0].d, 'M4 10L81 60');
  const visible = createScene();
  assert.throws(() => runCanvasProgram(visible, { commands: [{ op: 'draw', layer: { id: 'visual', parts: [pathPart] } }] }), /hero-art/);
  assert.equal(getElement(visible, 'visual').hidden, undefined);
});

test('draw accepts outer parts and partChanges without rewriting the raw tool arguments', () => {
  const start = createInitialPoster(project);
  const layer = { id: 'cat-art', x: 80, y: 330, w: 440, h: 250, viewWidth: 440, viewHeight: 250 };
  const outer = { op: 'draw', layer, parts: [pathPart] };
  const raw = structuredClone(outer);
  const nested = { op: 'draw', layer: { ...layer, parts: [pathPart] } };
  const { scene, patches } = runCanvasProgram(start, { commands: [outer] });
  assert.deepEqual(patches, runCanvasProgram(start, { commands: [nested] }).patches);
  assert.deepEqual(outer, raw);
  const partChanges = [{ op: 'set', id: 'outline', d: 'M8 10L50 70' }];
  const edited = runCanvasProgram(scene, { commands: [{ op: 'draw', layer: { id: 'cat-art' }, partChanges }] });
  assert.equal(getElement(edited.scene, 'cat-art').parts[0].d, partChanges[0].d);
  assert.throws(() => runCanvasProgram(start, { commands: [{ ...nested, parts: [pathPart] }] }), /draw\.parts.*draw\.layer\.parts/);
  assert.throws(() => runCanvasProgram(scene, { commands: [{ ...nested, partChanges }] }), /整体替换或逐个修改/);
});

test('part schema and validation distinguish path, line, and rectangle coordinates', () => {
  const tools = canvasProgramTool.function.parameters.properties.commands.items.properties;
  const variants = tools.layer.properties.parts.items.oneOf;
  const keys = shape => Object.keys(variants.find(variant => variant.properties.shape.enum.includes(shape)).properties);
  assert.deepEqual(keys('path'), ['id', 'shape', 'style', 'd']);
  assert.deepEqual(keys('line'), ['id', 'shape', 'style', 'points']);
  assert.deepEqual(keys('rect'), ['id', 'shape', 'style', 'x', 'y', 'w', 'h']);
  const start = createInitialPoster(project);
  const art = { id: 'hero-art', x: 70, y: 300, w: 150, h: 120, parts: [{ ...pathPart, x: 15 }] };
  assert.throws(() => runCanvasProgram(start, { commands: [{ op: 'draw', layer: art }] }), /path 部件请用 d.*draw\.layer/);
  assert.throws(() => runCanvasProgram(start, { commands: [{ op: 'arrange', operations: [{ op: 'set', id: 'title', script: 'malformed' }] }] }), /不支持字段 script/);
});

test('new drafts start on A3 and exports preserve the paper size and working pixels', () => {
  const start = createInitialPoster(project);
  assert.deepEqual(start.paper, { widthMm: 297, heightMm: 420, format: 'A3' });
  assert.equal(getElement(start, 'info').venue, project.facts.venue);
  const markup = posterSVG(start);
  assert.match(markup, /width="297mm" height="420mm" viewBox="0 0 594 840"/);
  const png = rasterizePoster(markup).asPng();
  assert.equal(png.toString('ascii', 37, 41), 'pHYs');
  assert.deepEqual([png.readUInt32BE(41), png.readUInt32BE(45), png[49]], [2000, 2000, 1]);
  const { width, height } = verifyPosterPngBytes(png);
  assert.deepEqual([width, height], [594, 840]);
  assert.deepEqual(applyPatch(start, [{ op: 'resize', preset: 'A3' }]).diff, []);
  assert.throws(() => posterSVG({ ...start, height: 800 }), /viewBox/);
});

test('resizing a legacy poster preserves its QR, review evidence and scale of artwork', () => {
  const original = createScene();
  const oldMarkup = posterSVG(original);
  assert.match(oldMarkup, /width="600" height="800" viewBox="0 0 600 800"/);
  const { scene, diff } = applyPatch(original, [{ op: 'resize', preset: 'A4' }]);
  assert.equal(original.paper, undefined);
  assert.deepEqual(diff[0], { id: '$canvas', before: { width: 600, height: 800, paper: null },
    after: { width: 420, height: 594, paper: { widthMm: 210, heightMm: 297, format: 'A4' } } });
  const qr = getElement(scene, 'qr');
  assert.equal(qr.w, qr.h);
  assert.equal(verifyPosterQR(scene, posterSVG(scene), { reachable: true }), 'verified');
  assert.deepEqual(Object.values(reviewScene(scene, { qr: 'verified' })).map(entry => entry.score), [100, 100, 85]);
  assert.equal(getElement(scene, 'title').x / scene.width, getElement(original, 'title').x / original.width);
});

test('resize preserves editable mask geometry and takes effect before subsequent layout edits', () => {
  const start = runCanvasProgram(createInitialPoster(project), { commands: [
    { op: 'draw', layer: { id: 'swatch', x: 150, y: 390, w: 100, h: 100, parts: [
      { id: 'color', shape: 'rect', x: 0, y: 0, w: 100, h: 100, style: { fill: '#aa2244' } },
    ] } },
    { op: 'paint', id: 'swatch', mask: { mode: 'reveal', parts: [
      { id: 'left', shape: 'rect', x: 0, y: 0, w: 50, h: 100 },
    ] } },
  ] }).scene;
  const { scene, patches } = runCanvasProgram(start, { commands: [
    { op: 'resize', widthMm: 350, heightMm: 500 },
    { op: 'text', layers: [{ id: 'note', x: 600, y: 905, w: 75, h: 50, text: 'New area' }] },
  ] });
  assert.deepEqual([scene.width, scene.height, scene.paper.format], [700, 1000, 'custom']);
  assert.equal(getElement(scene, 'note').y, 905);
  assert.deepEqual(applyPatch(start, patches).scene, scene);
  const { x, y, w, h, mask, parts } = getElement(scene, 'swatch');
  assert.deepEqual(parts, getElement(start, 'swatch').parts);
  assert.deepEqual([mask.viewWidth, mask.viewHeight], [100, 100]);
  const raster = rasterizePoster(posterSVG(scene));
  const pixel = fraction => {
    const offset = (Math.floor(y + h / 2) * raster.width + Math.floor(x + w * fraction)) * 4;
    return [...raster.pixels.subarray(offset, offset + 4)];
  };
  assert.deepEqual(pixel(.25), [170, 34, 68, 255]);
  assert.deepEqual(pixel(.75), [255, 255, 255, 255]);
  for (const size of [{ preset: 'A1' }, { preset: 'A4', widthMm: 210 }, { widthMm: 401, heightMm: 400 }, { widthMm: 300.5, heightMm: 400 }]) {
    assert.throws(() => runCanvasProgram(start, { commands: [{ op: 'resize', ...size }] }), /portrait paper|paper preset/);
  }
});
