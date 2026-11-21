import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import regularFont from '../server/poster-assets/museum-regular.ttf';
import boldFont from '../server/poster-assets/museum-extrabold.ttf';
import chineseFont from '../server/poster-assets/museum-cjk.ttf';
import serifFont from '../server/poster-assets/museum-serif.ttf';
import monoFont from '../server/poster-assets/museum-mono.ttf';
import condensedRegular from '../server/poster-assets/barlow-condensed-regular.ttf';
import condensedBold from '../server/poster-assets/barlow-condensed-bold.ttf';
import displayRegular from '../server/poster-assets/dm-serif-display-regular.ttf';
import displayItalic from '../server/poster-assets/dm-serif-display-italic.ttf';
import regularWebfont from '../server/poster-assets/museum-regular.woff2';
import boldWebfont from '../server/poster-assets/museum-extrabold.woff2';
import { enUsPosterFontFile, enUsPosterFontPath } from '../server/poster-fonts.mjs';
import { decodePosterQR, designFontStyles, embedCjkFallback, needsFontFallback, posterFontStyles, renderPosterSVG, usedDesignFonts } from '../server/poster-svg.mjs';
import { attachPngResolution, posterRasterSource } from '../server/poster-raster.mjs';
import { embeddedStaticAsset } from './static.mjs';

function toBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x4000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x4000)));
  return btoa(chunks.join(''));
}
const styles = posterFontStyles(toBase64(regularWebfont), toBase64(boldWebfont));
const fontAssets = {
  'museum-cjk.ttf': chineseFont, 'museum-serif.ttf': serifFont, 'museum-mono.ttf': monoFont,
  'barlow-condensed-regular.ttf': condensedRegular, 'barlow-condensed-bold.ttf': condensedBold,
  'dm-serif-display-regular.ttf': displayRegular, 'dm-serif-display-italic.ttf': displayItalic,
};
const designFontData = new Map();
let initialized;
let enUsFontBytes;

export function initializePoster() {
  initialized ??= initWasm(wasm);
  return initialized;
}

function encodedFont(file) {
  if (file === enUsPosterFontFile) {
    const encoded = embeddedStaticAsset(enUsPosterFontPath);
    if (encoded === undefined) throw new Error('The EN-US.TTF font asset is missing from the site build.');
    return encoded;
  }
  if (!designFontData.has(file)) designFontData.set(file, toBase64(fontAssets[file]));
  return designFontData.get(file);
}

function fontBytes(file) {
  if (file !== enUsPosterFontFile) return fontAssets[file];
  return enUsFontBytes ??= Buffer.from(encodedFont(file), 'base64');
}

export function posterSVG(scene) {
  const svg = renderPosterSVG(scene, styles + designFontStyles(scene, encodedFont));
  return embedCjkFallback(svg, encodedFont);
}

export function rasterizePoster(svg) {
  const fontBuffers = needsFontFallback(svg) ? [regularFont, boldFont, chineseFont] : [regularFont, boldFont];
  fontBuffers.push(...usedDesignFonts(svg).map(fontBytes));
  const source = posterRasterSource(svg);
  const renderer = new Resvg(source.svg, {
    font: { fontBuffers, defaultFontFamily: 'MuseumPoster', sansSerifFamily: 'MuseumPoster' },
  });
  try {
    const image = renderer.render();
    try {
      const { width, height, pixels } = image;
      const png = attachPngResolution(image.asPng(), source.pixelsPerMetre);
      return { width, height, pixels, asPng: () => png };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

export function verifyPosterQR(scene, svg, { reachable, rgba } = {}) {
  return decodePosterQR(scene, () => rgba ?? rasterizePoster(svg ?? posterSVG(scene)), reachable);
}
