import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { build as buildUI } from 'vite';

const project = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(project, 'dist');
const workbenchSource = path.join(project, 'frontend', 'src', 'workbench');
const worker = path.join(dist, 'server');
const metadata = path.join(dist, '.openai');
const entrypoint = path.join(worker, 'index.js');
const wasmModule = '@resvg/resvg-wasm/index_bg.wasm';
const wasmFile = 'resvg_bg.wasm';
const formats = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'], ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf']
]);
async function assetEntry(source, name, mime) {
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return [`/${name}`, [mime, digest, bytes.length, bytes.toString('base64')]];
}

async function assetMap(directory, relative = '') {
  const entries = [];
  const children = await readdir(directory, { withFileTypes: true });
  for (const item of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = relative + item.name;
    const filename = path.join(directory, item.name);
    if (item.isDirectory() && (relative || item.name === 'assets') && !item.name.startsWith('.')) {
      entries.push(...await assetMap(filename, `${name}/`));
      continue;
    }
    const mime = formats.get(path.extname(item.name).toLowerCase());
    if (!item.isFile() || !mime || item.name.startsWith('.')) continue;
    entries.push(await assetEntry(filename, name, mime));
  }
  return entries;
}

await buildUI({ configFile: path.join(project, 'vite.config.mjs') });
const sourceEntries = await assetMap(dist);
const generatedEntries = await assetMap(path.join(dist, 'client'));
const runtimeFiles = ['recognition-worklet.js', 'replay-player.js', 'replay.css'];
const runtimeEntries = await Promise.all(runtimeFiles.map((name) => assetEntry(path.join(workbenchSource, name), name, formats.get(path.extname(name)))));
const entries = [...sourceEntries, ...generatedEntries, ...runtimeEntries];
for (const required of [
  '/index.html', '/workbench.html', '/reservation.html', '/assets/fonts/en-us.ttf',
  '/assets/characters/manga-cast.png', '/assets/characters/manga-employee.png'
]) {
  if (!entries.some(([pathname, entry]) => pathname === required && entry[3])) throw new Error(`缺少 Worker 页面资源 ${required}`);
}
const bytes = new Map();
const assets = Object.fromEntries(entries.map(([pathname, [mime, digest, length, encoded]]) => {
  if (!bytes.has(digest)) bytes.set(digest, encoded);
  return [pathname, [mime, digest, length, true]];
}));
const wasmInput = fileURLToPath(import.meta.resolve(wasmModule));
const { static: _static, ...hosting } = JSON.parse(await readFile(path.join(project, '.openai/hosting.json'), 'utf8'));

const result = await build({
  absWorkingDir: project,
  entryPoints: ['worker/index.mjs'],
  outfile: entrypoint,
  write: false,
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
  loader: { '.ttf': 'binary', '.woff': 'binary', '.woff2': 'binary', '.sql': 'text' },
  legalComments: 'inline',
  plugins: [{
    name: 'studio-worker-assets',
    setup(plugin) {
      plugin.onResolve({ filter: /^studio:static-assets$/ }, () => ({ path: 'static-assets', namespace: 'studio' }));
      plugin.onLoad({ filter: /^static-assets$/, namespace: 'studio' }, () => ({
        contents: `export default ${JSON.stringify(assets)};\nexport const contents = ${JSON.stringify(Object.fromEntries(bytes))};`, loader: 'js'
      }));
      plugin.onResolve({ filter: /^@resvg\/resvg-wasm\/index_bg\.wasm$/ }, () => ({
        path: `./${wasmFile}`, external: true
      }));
    }
  }]
});

const artifact = result.outputFiles.find((file) => file.path === entrypoint);
if (!artifact) throw new Error('Worker 构建没有生成默认入口');
await Promise.all([mkdir(worker, { recursive: true }), mkdir(metadata, { recursive: true })]);
await Promise.all([
  copyFile(wasmInput, path.join(worker, wasmFile)),
  writeFile(entrypoint, artifact.contents),
  writeFile(path.join(metadata, 'hosting.json'), `${JSON.stringify(hosting, null, 2)}\n`)
]);
const quantity = Object.values(assets).filter((entry) => entry[3]).length;
const wasm = await readFile(wasmInput);
const gzipBytes = gzipSync(artifact.contents).length + gzipSync(wasm).length;
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(`已构建 dist/server/index.js，${quantity} 项内置页面资源，Worker 与 WASM 共 ${mib(artifact.contents.length + wasm.length)}，gzip ${mib(gzipBytes)}。`);
