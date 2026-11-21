export const paperUnitsPerMm = 2;
export const defaultPaperFormat = 'A3';
export const posterPaperLimits = Object.freeze({ minWidth: 210, maxWidth: 420, minHeight: 297, maxHeight: 594 });

const formats = Object.freeze({ A4: [210, 297], A3: [297, 420], A2: [420, 594] });
export const posterPaperFormats = Object.freeze(Object.keys(formats));

export function posterPaper({ preset, widthMm, heightMm }) {
  if (preset !== undefined) {
    if (widthMm !== undefined || heightMm !== undefined || typeof preset !== 'string' || !Object.hasOwn(formats, preset)) {
      throw new Error('Use one paper preset (A4, A3 or A2) or enter both dimensions in millimetres.');
    }
    [widthMm, heightMm] = formats[preset];
  }
  const { minWidth, maxWidth, minHeight, maxHeight } = posterPaperLimits;
  if (!Number.isInteger(widthMm) || !Number.isInteger(heightMm) || widthMm >= heightMm ||
      widthMm < minWidth || widthMm > maxWidth || heightMm < minHeight || heightMm > maxHeight) {
    throw new Error('Use portrait paper from 210–420 mm wide and 297–594 mm high (whole millimetres).');
  }
  const format = posterPaperFormats.find(name => formats[name][0] === widthMm && formats[name][1] === heightMm) ?? 'custom';
  return { widthMm, heightMm, format };
}

export function canvasDimensions({ width, height, paper }) {
  return { width, height, ...(paper ? { paper } : {}) };
}
