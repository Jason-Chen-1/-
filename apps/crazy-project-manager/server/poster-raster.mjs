import { crc32 } from 'node:zlib';
import { paperUnitsPerMm } from './poster-paper.mjs';

const physicalSvg = /^(<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" )width="(\d+)mm" height="(\d+)mm"( viewBox="0 0 (\d+) (\d+)")/;

export function posterRasterSource(svg) {
  const opening = physicalSvg.exec(svg);
  if (!opening) return { svg };
  const [prefix, namespace, widthMm, heightMm, viewBox, width, height] = opening;
  if (widthMm * paperUnitsPerMm !== Number(width) || heightMm * paperUnitsPerMm !== Number(height)) return { svg };
  // Render the same viewBox in workbench pixels. Resvg otherwise interprets mm at 96 dpi.
  return {
    svg: `${namespace}width="${width}" height="${height}"${viewBox}${svg.slice(prefix.length)}`,
    pixelsPerMetre: paperUnitsPerMm * 1000,
  };
}

export function attachPngResolution(bytes, pixelsPerMetre) {
  if (!pixelsPerMetre) return bytes;
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const density = Buffer.alloc(21);
  density.writeUInt32BE(9, 0);
  density.write('pHYs', 4, 'ascii');
  density.writeUInt32BE(pixelsPerMetre, 8);
  density.writeUInt32BE(pixelsPerMetre, 12);
  density[16] = 1;
  density.writeUInt32BE(crc32(density.subarray(4, 17)), 17);

  // Insert after IHDR, or replace a density already set by the encoder.
  for (let at = 33; at + 12 <= png.length;) {
    const type = png.toString('ascii', at + 4, at + 8);
    const next = at + 12 + png.readUInt32BE(at);
    if (type === 'pHYs') return Buffer.concat([png.subarray(0, at), density, png.subarray(next)]);
    if (type === 'IDAT') break;
    at = next;
  }
  return Buffer.concat([png.subarray(0, 33), density, png.subarray(33)]);
}
