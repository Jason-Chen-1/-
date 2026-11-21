import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { runCanvasProgram } from '../server/canvas-program.mjs';
import { createInitialPoster } from '../server/initial-poster.mjs';
import { enUsPosterFontPath } from '../server/poster-fonts.mjs';
import * as nodePoster from '../server/poster-render.mjs';
import { projectTheme } from '../server/project-theme.mjs';

test('workerd renders, edits and decodes the same poster version with its compiled Wasm module', async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const enUsFont = readFileSync(new URL(`../dist${enUsPosterFontPath}`, import.meta.url));
  const sha = data => createHash('sha256').update(data).digest('hex');
  const enUsHash = sha(enUsFont);
  const fixture = `
    import { initializePoster, posterSVG, rasterizePoster, verifyPosterQR } from './worker/poster.mjs';
    import { serveStatic } from './worker/static.mjs';
    import { createScene, applyPatch, applyUpload } from './server/poster.mjs';
    import { reviewScene } from './server/poster-review.mjs';
    import { planEdit } from './server/poster-edit.mjs';

    export default { async fetch(request) {
      await Promise.all([initializePoster(), initializePoster()]);
      const route = new URL(request.url).pathname;
      if (route === ${JSON.stringify(enUsPosterFontPath)}) return serveStatic(request);
      if (route === '/fonts' || route === '/blend') {
        const svg = posterSVG(await request.json());
        const raster = rasterizePoster(svg);
        if (route === '/blend') {
          const samples = [170, 210].map(x => Array.from(raster.pixels.slice((430 * raster.width + x) * 4, (430 * raster.width + x + 1) * 4)));
          return Response.json({ samples, signature: Array.from(raster.asPng().subarray(0, 8)) });
        }
        const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), x => x.toString(16).padStart(2, '0')).join('');
        const png = raster.asPng();
        const density = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(41);
        return Response.json({ svg: await hash(new TextEncoder().encode(svg)), pixels: await hash(raster.pixels),
          dimensions: [raster.width, raster.height], density });
      }
      let scene = createScene();
      if (route === '/upload') {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="14"><rect width="15" height="14" fill="#7550bc"/></svg>';
        const pixels = rasterizePoster(svg).asPng();
        scene = applyUpload(scene, 'data:image/png;base64,' + btoa(String.fromCharCode(...pixels)), '主图.png').scene;
      }
      if (route === '/conflict' || route === '/agreement') {
        const plan = planEdit('把免费 · 须预约做成标题旁的大黄贴', scene);
        scene = applyPatch(scene, plan.patches).scene;
      }
      if (route === '/agreement') scene = applyPatch(scene, planEdit('把黄贴移到预约码旁边，别动馆标', scene).patches).scene;
      const svg = posterSVG(scene);
      const raster = rasterizePoster(svg);
      const qr = verifyPosterQR(scene, svg, { reachable: true, rgba: raster });
      const scores = Object.values(reviewScene(scene, { qr })).map(review => review.score);
      const glyph = rasterizePoster('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><text font-family="MuseumPosterCJK" x="4" y="45" font-size="34">虹桥</text></svg>');
      const ink = glyph.pixels.reduce((sum, value, i) => sum + Number(i % 4 === 3 && value > 128), 0);
      const center = Array.from(raster.pixels.slice((400 * raster.width + 300) * 4, (400 * raster.width + 301) * 4));
      return Response.json({ qr, scores, dimensions: [raster.width, raster.height], ink, center });
    }};
  `;
  const packed = await build({
    stdin: { contents: fixture, resolveDir: project }, write: false, bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*'],
    loader: { '.ttf': 'binary', '.woff2': 'binary' },
    plugins: [{ name: 'studio-fixture-assets', setup(plugin) {
      plugin.onResolve({ filter: /^@resvg\/resvg-wasm\/index_bg\.wasm$/ }, () => ({ path: './resvg_bg.wasm', external: true }));
      plugin.onResolve({ filter: /^studio:static-assets$/ }, () => ({ path: 'static-assets', namespace: 'studio' }));
      plugin.onLoad({ filter: /^static-assets$/, namespace: 'studio' }, () => ({
        contents: `export default ${JSON.stringify({ [enUsPosterFontPath]: ['font/ttf', enUsHash, enUsFont.length, true] })};\n` +
          `export const contents = ${JSON.stringify({ [enUsHash]: enUsFont.toString('base64') })};`,
      }));
    } }],
  });
  const bytes = readFileSync(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  const studio = new Miniflare({
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], modulesRoot: project,
    modules: [
      { type: 'ESModule', path: 'poster-test.mjs', contents: packed.outputFiles[0].text },
      { type: 'CompiledWasm', path: 'resvg_bg.wasm', contents: bytes },
    ],
  });
  t.after(() => studio.dispose());

  for (const [route, scores] of [['/', [100, 100, 85]], ['/conflict', [80, 65, 100]], ['/agreement', [100, 100, 100]]]) {
    const response = await studio.dispatchFetch(`http://studio.test${route}`);
    const body = await response.text();
    assert.ok(response.ok, body);
    const actual = JSON.parse(body);
    assert.deepEqual(actual.dimensions, [600, 800]);
    assert.equal(actual.qr, 'verified');
    assert.deepEqual(actual.scores, scores);
    assert.ok(actual.ink > 120, 'non-template Chinese glyphs render without system fonts');
  }

  const upload = await studio.dispatchFetch('http://studio.test/upload');
  const body = await upload.text();
  assert.ok(upload.ok, body);
  assert.deepEqual(JSON.parse(body).center, [117, 80, 188, 255]);

  const base = createInitialPoster(projectTheme(undefined, { topic: 'Botanical Sketchbook' }));
  const { scene } = runCanvasProgram(base, { commands: [{ op: 'text', layers: [
    { id: 'title', style: { fontFamily: 'condensed', fontWeight: 700 } },
    { id: 'visitor-note', x: 25, y: 400, w: 520, h: 75, text: '虹桥 Botanical Walk',
      style: { fontFamily: 'display', fontStyle: 'italic', fontSize: 33 } },
  ] }] });
  const response = await studio.dispatchFetch('http://studio.test/fonts', { method: 'POST', body: JSON.stringify(scene) });
  assert.ok(response.ok, await response.clone().text());
  const svg = nodePoster.posterSVG(scene);
  assert.deepEqual(await response.json(), { svg: sha(svg), pixels: sha(nodePoster.rasterizePoster(svg).pixels),
    dimensions: [594, 840], density: 2000 });
  const enlarged = runCanvasProgram(scene, { commands: [{ op: 'resize', preset: 'A2' }] }).scene;
  const a2 = await studio.dispatchFetch('http://studio.test/fonts', { method: 'POST', body: JSON.stringify(enlarged) });
  assert.ok(a2.ok, await a2.clone().text());
  const a2Svg = nodePoster.posterSVG(enlarged);
  assert.deepEqual(await a2.json(), { svg: sha(a2Svg), pixels: sha(nodePoster.rasterizePoster(a2Svg).pixels),
    dimensions: [840, 1188], density: 2000 });

  const uploadedFontResponse = await studio.dispatchFetch(`http://studio.test${enUsPosterFontPath}`);
  assert.equal(uploadedFontResponse.headers.get('Content-Type'), 'font/ttf');
  assert.equal(sha(Buffer.from(await uploadedFontResponse.arrayBuffer())), enUsHash);
  const uploadedScene = runCanvasProgram(scene, { commands: [{ op: 'text', layers: [
    { id: 'visitor-note', style: { fontFamily: 'en-us' } },
  ] }] }).scene;
  const uploadedSvg = nodePoster.posterSVG(uploadedScene);
  const uploadedRender = await studio.dispatchFetch('http://studio.test/fonts', { method: 'POST', body: JSON.stringify(uploadedScene) });
  assert.ok(uploadedRender.ok, await uploadedRender.clone().text());
  const expectedPixels = sha(nodePoster.rasterizePoster(uploadedSvg).pixels);
  assert.notEqual(expectedPixels, sha(nodePoster.rasterizePoster(svg).pixels));
  assert.deepEqual(await uploadedRender.json(), { svg: sha(uploadedSvg), pixels: expectedPixels, dimensions: [594, 840], density: 2000 });

  const solid = fill => 'data:image/png;base64,' + nodePoster.rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`).asPng().toString('base64');
  const image = fill => ({ type: 'image', x: 145, y: 410, w: 100, h: 40, fit: 'fill', image: solid(fill) });
  const blended = runCanvasProgram(base, { commands: [
    { op: 'arrange', operations: [
      { op: 'add', element: { ...image('#40a060'), id: 'underlay', label: 'Underlay' } },
      { op: 'add', element: { ...image('#c050e0'), id: 'overlay', label: 'Overlay' } },
    ] },
    { op: 'paint', id: 'overlay', style: { blendMode: 'multiply', opacity: .5 },
      mask: { mode: 'reveal', parts: [{ id: 'left', shape: 'rect', x: 0, y: 0, w: 45, h: 40 }] } },
  ] }).scene;
  const composite = await studio.dispatchFetch('http://studio.test/blend', { method: 'POST', body: JSON.stringify(blended) });
  assert.ok(composite.ok, await composite.clone().text());
  assert.deepEqual(await composite.json(), { samples: [[56, 105, 90, 255], [64, 160, 96, 255]],
    signature: Array.from(Buffer.from('89504e470d0a1a0a', 'hex')) });
});
