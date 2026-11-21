import { readFile, writeFile } from 'node:fs/promises';
import { runCanvasProgram } from '../server/canvas-program.mjs';
import { createScene } from '../server/poster.mjs';
import { posterSVG } from '../server/poster-render.mjs';

const [input, output, ...extra] = process.argv.slice(2);
if (!input || input === '--help') {
  process.stdout.write('用法  npm run canvas -- drawing.json poster.svg\n用 - 从标准输入读取指令，省略输出文件则打印 SVG。\n');
} else if (extra.length) {
  process.stderr.write('只接受指令文件和可选输出文件。\n');
  process.exitCode = 1;
} else {
  try {
    let source = '';
    if (input === '-') {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) source += chunk;
    } else {
      source = await readFile(input, 'utf8');
    }
    const request = JSON.parse(source.replace(/^\uFEFF/, ''));
    const { scene } = runCanvasProgram(createScene(), Array.isArray(request) ? { commands: request } : request);
    const svg = posterSVG(scene);
    if (output) await writeFile(output, svg);
    else process.stdout.write(svg);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
