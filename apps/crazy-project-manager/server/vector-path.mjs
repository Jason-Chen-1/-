import svgpath from 'svgpath';

export const maxVectorCoordinate = 10000;

export function normalizeVectorPath(value) {
  if (typeof value !== 'string' || value.length > 4800) throw new Error('SVG 路径须为 4800 字符以内的绘图命令。');
  const path = svgpath(value.trim());
  if (path.err || !path.segments.length) throw new Error('SVG 路径坐标或命令格式无效。');
  for (const [command, ...values] of path.segments) {
    if (values.some(coordinate => !Number.isFinite(coordinate) || Math.abs(coordinate) > maxVectorCoordinate)) {
      throw new Error('SVG 路径坐标超出范围。');
    }
    if (command.toUpperCase() === 'A' && (values[0] < 0 || values[1] < 0)) throw new Error('SVG 圆弧半径不能为负数。');
  }
  return path.round(3).toString();
}
