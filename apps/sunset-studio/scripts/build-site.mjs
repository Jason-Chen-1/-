import {build} from 'esbuild';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {assetType} from '../server/assets.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = path.join(project, 'public');
const files = await readdir(publicRoot, {recursive: true, withFileTypes: true});
const assets = {};
for (const file of files) {
  if (!file.isFile()) continue;
  const contentType = assetType(file.name);
  if (!contentType) continue;
  const filename = path.join(file.parentPath, file.name);
  const name = path.relative(publicRoot, filename).split(path.sep).join('/');
  assets[`/${name}`] = {contentType, base64: (await readFile(filename)).toString('base64')};
}
if (!assets['/index.html'] || !assets['/assets/art/studio.webp']) throw new Error('The public studio assets are incomplete.');

const entry = path.join(project, 'dist/server/index.js');
await build({
  entryPoints: [path.join(project, 'worker/index.mjs')], outfile: entry, bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  define: {__SUNSET_ASSETS__: JSON.stringify(assets)},
});

const hostingFile = '.openai/hosting.json';
const hosting = JSON.parse(await readFile(path.join(project, hostingFile), 'utf8'));
if (hosting.static || hosting.d1 !== 'DB') throw new Error('Check the Worker hosting manifest and database binding.');
await mkdir(path.join(project, 'dist/.openai'), {recursive: true});
await writeFile(path.join(project, 'dist', hostingFile), JSON.stringify(hosting, null, 2) + '\n');
const size = gzipSync(await readFile(entry)).length;
console.log(`Built Sunset Studio Worker with ${Object.keys(assets).length} assets (${(size / 1048576).toFixed(2)} MiB gzip).`);
