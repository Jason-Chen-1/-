import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { enUsPosterFontFile, enUsPosterFontPath } from './poster-fonts.mjs';
import { decodePosterQR, designFontStyles, embedCjkFallback, needsFontFallback, posterFontStyles, renderPosterSVG, usedDesignFonts } from './poster-svg.mjs';
import { attachPngResolution, posterRasterSource } from './poster-raster.mjs';

const asset = name => new URL(name === enUsPosterFontFile ? `../dist${enUsPosterFontPath}` : `./poster-assets/${name}`, import.meta.url);
const baseFonts = ['museum-regular.ttf', 'museum-extrabold.ttf'];
const styles = posterFontStyles(...['regular', 'extrabold'].map(style => readFileSync(asset(`museum-${style}.woff2`)).toString('base64')));
const designFontData = new Map();

function encodedFont(file) {
  if (!designFontData.has(file)) designFontData.set(file, readFileSync(asset(file)).toString('base64'));
  return designFontData.get(file);
}

export function posterSVG(scene) {
  const svg = renderPosterSVG(scene, styles + designFontStyles(scene, encodedFont));
  return embedCjkFallback(svg, encodedFont);
}

export function rasterizePoster(svg) {
  const fallback = needsFontFallback(svg);
  const files = [...baseFonts, ...usedDesignFonts(svg)];
  if (fallback) files.push('museum-cjk.ttf');
  const font = { fontFiles: files.map(name => fileURLToPath(asset(name))), loadSystemFonts: fallback, defaultFontFamily: 'MuseumPoster', sansSerifFamily: 'MuseumPoster' };
  const source = posterRasterSource(svg);
  const image = new Resvg(source.svg, { font }).render();
  if (!source.pixelsPerMetre) return image;
  let png;
  return {
    width: image.width,
    height: image.height,
    get pixels() { return image.pixels; },
    asPng: () => (png ??= attachPngResolution(image.asPng(), source.pixelsPerMetre)),
  };
}

export function verifyPosterQR(scene, svg, { reachable, rgba } = {}) {
  return decodePosterQR(scene, () => rgba ?? rasterizePoster(svg ?? posterSVG(scene)), reachable);
}
