import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import path from 'node:path';

const files = ['server.mjs', ...['public', 'scripts', 'server', 'worker'].flatMap(directory =>
  readdirSync(directory).filter(file => /\.(?:m?js)$/.test(file)).map(file => path.join(directory, file)))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
