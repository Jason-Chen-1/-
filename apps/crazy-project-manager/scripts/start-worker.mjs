import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';

const project = fileURLToPath(new URL('../', import.meta.url));
const modulesRoot = path.join(project, 'dist', 'server');
const migrations = path.join(project, 'drizzle');

function localBindings(env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined &&
    /^(?:STUDIO_|VOLCENGINE_|FISH_|OPENROUTER_|OPENCODE_GO_|AMD_CREATIVE_HUB_)/.test(name) &&
    !name.startsWith('STUDIO_WORKER_') && name !== 'STUDIO_DATA_DIR'));
}

async function applyMigrations(database) {
  await database.prepare('CREATE TABLE IF NOT EXISTS studio_local_migrations (name TEXT PRIMARY KEY)').run();
  const { results } = await database.prepare('SELECT name FROM studio_local_migrations').all();
  const applied = new Set(results.map(({ name }) => name));
  const entries = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of entries) {
    if (applied.has(name)) continue;
    const file = await readFile(path.join(migrations, name), 'utf8');
    const statements = file.split(/^-->\s*statement-breakpoint\s*$/m).map((source) => source.trim()).filter(Boolean);
    await database.batch([
      ...statements.map((statement) => database.prepare(statement)),
      database.prepare('INSERT OR IGNORE INTO studio_local_migrations (name) VALUES (?)').bind(name)
    ]);
  }
}

export async function startLocalWorker({
  port = Number(process.env.STUDIO_WORKER_PORT ?? 8787),
  dataDirectory = process.env.STUDIO_WORKER_DATA_DIR || path.join(project, '.studio-worker-data'),
  bindings = localBindings(process.env),
  outboundService
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('STUDIO_WORKER_PORT 必须在 0 到 65535 之间');
  const hosting = JSON.parse(await readFile(path.join(project, 'dist', '.openai', 'hosting.json'), 'utf8'));
  const database = (typeof hosting.d1 === 'string' ? hosting.d1 : hosting.d1?.binding) || 'DB';
  const bucket = (typeof hosting.r2 === 'string' ? hosting.r2 : hosting.r2?.binding) || 'BUCKET';
  const studio = new Miniflare({
    host: '127.0.0.1',
    port,
    modules: true,
    modulesRoot,
    scriptPath: path.join(modulesRoot, 'index.js'),
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings,
    outboundService,
    d1Databases: { [database]: 'studio-worker-local-db' },
    d1Persist: path.resolve(dataDirectory, 'd1'),
    r2Buckets: { [bucket]: 'studio-worker-local-files' },
    r2Persist: path.resolve(dataDirectory, 'r2')
  });
  try {
    const address = await studio.ready;
    await applyMigrations(await studio.getD1Database(database));
    return { studio, address };
  } catch (error) {
    await studio.dispose();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await import('./build-worker.mjs');
  const { studio, address } = await startLocalWorker();
  console.log(`疯狂的项目经理 · Worker ${address.href}`);
  process.once('SIGINT', () => void studio.dispose());
  process.once('SIGTERM', () => void studio.dispose());
}
