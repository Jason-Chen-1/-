// Barlow Condensed and DM Serif Display are unhinted Latin and punctuation subsets
// from google/fonts@06bfe0d62a98375cb09c942fa18e68bd32cff057. Their OFL licenses are in poster-assets.
export const enUsPosterFontFile = 'en-us.ttf';
export const enUsPosterFontPath = `/assets/fonts/${enUsPosterFontFile}`;

export const posterFonts = Object.freeze({
  sans: { name: 'MuseumPoster', description: 'neutral sans with Chinese support', faces: [] },
  serif: { name: 'MuseumSerif', description: 'editorial serif with common Chinese glyphs', generic: 'serif',
    faces: [{ file: 'museum-serif.ttf', weight: 400 }] },
  mono: { name: 'MuseumMono', description: 'monospaced type for labels and data', generic: 'monospace',
    faces: [{ file: 'museum-mono.ttf', weight: 400 }] },
  condensed: { name: 'Barlow Condensed', description: 'narrow sans for bold headlines, weights 400 and 700', generic: 'sans-serif',
    staticFaces: true, faces: [{ file: 'barlow-condensed-regular.ttf', weight: 400 }, { file: 'barlow-condensed-bold.ttf', weight: 700 }] },
  display: { name: 'DM Serif Display', description: 'high-contrast display serif, with regular and italic', generic: 'serif',
    staticFaces: true, faces: [{ file: 'dm-serif-display-regular.ttf', weight: 400 }, { file: 'dm-serif-display-italic.ttf', weight: 400, style: 'italic' }] },
  'en-us': { name: 'SDK_US_Web', description: 'uploaded EN-US.TTF for Chinese and English, regular weight 400', generic: 'sans-serif',
    aliases: [enUsPosterFontFile, 'SDK_US_Web Regular'], staticFaces: true, faces: [{ file: enUsPosterFontFile, weight: 400 }] },
});

export const posterFontIds = Object.freeze(Object.keys(posterFonts));
export const posterFontChoices = Object.entries(posterFonts).map(([id, font]) => `${id} (${font.description})`).join(', ');
