import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { readSharedSettings, sharedSettingsStatus } from '../worker/voice-settings.mjs';
import { settingsDefaults, volcSentenceASR } from './runtime-config.mjs';
import { createSettings } from './settings.mjs';

const mode = 'volcengine-sentence';
const legacyKey = 'sentence-fixture-legacy-key';
const independentKey = 'sentence-fixture-independent-key';
const concurrent = 'volc.seedasr.sauc.concurrent';

test('本机 ASR 可选一句话小时/并发模式，复用密钥并可单独清除', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'studio-sentence-settings-'));
  const filename = path.join(directory, '.env');
  t.after(() => { rmSync(filename, { force: true }); rmdirSync(directory); });
  const settings = createSettings(filename, { VOLCENGINE_ASR_API_KEY: legacyKey });
  assert.equal(settings.status().asr.mode, 'browser');
  const result = settings.update({ asr: { mode, resourceId: concurrent, url: 'wss://untrusted.example.test/' } });
  assert.deepEqual([result.asr.mode, result.asr.resourceId, result.asr.hasKey, result.asr.url], [mode, concurrent, true, volcSentenceASR]);
  assert.equal(settings.read().asr.key, legacyKey);
  assert.ok(!JSON.stringify(result).includes(legacyKey));
  assert.throws(() => settings.update({ asr: { mode, resourceId: 'volc.seedasr.auc' } }), { statusCode: 400 });
  settings.update({ asr: { mode, key: independentKey } });
  assert.equal(settings.read().asr.key, independentKey);
  assert.equal(settings.read().asr.resourceId, concurrent);
  assert.equal(settings.update({ asr: { mode, clearKey: true } }).asr.hasKey, false);
  assert.equal(settings.read().asr.providers.volcengine.key, legacyKey);
});

test('Worker 从已加密的火山旧设置复用 ASR 密钥并独立保存一句话资源', async t => {
  const studio = new Miniflare({
    modules: true, compatibilityDate: '2026-07-01', script: 'export default { fetch: () => new Response(null) };',
    d1Databases: { DB: 'studio-sentence-fixture' },
  });
  t.after(() => studio.dispose());
  const DB = await studio.getD1Database('DB');
  await DB.prepare(readFileSync(new URL('../drizzle/0001_voice_settings.sql', import.meta.url), 'utf8').trim()).run();
  const admin = 'sentence-fixture-admin';
  const env = { DB, STUDIO_SETTINGS_SECRET: '3c'.repeat(32), STUDIO_SETTINGS_ADMIN_KEY: admin };
  const defaults = settingsDefaults();
  const request = (asr, key = admin) => sharedSettingsStatus(new Request('https://studio.test/api/settings', {
    method: asr ? 'POST' : 'GET', headers: key ? { 'X-Studio-Settings-Key': key } : {},
  }), env, defaults, async () => ({ asr }));

  await request({ mode: 'volcengine', key: legacyKey });
  const saved = await request({ mode, resourceId: concurrent, url: 'wss://untrusted.example.test/' });
  assert.deepEqual([saved.asr.mode, saved.asr.resourceId, saved.asr.hasKey, saved.asr.url], [mode, concurrent, true, volcSentenceASR]);
  assert.equal((await readSharedSettings(env, defaults)).asr.key, legacyKey);
  assert.ok(!JSON.stringify(await request(null, null)).includes(legacyKey));
  await assert.rejects(request({ mode, resourceId: 'volc.bigasr.auc_turbo' }), { statusCode: 400 });
  await request({ mode, key: independentKey });
  assert.equal((await readSharedSettings(env, defaults)).asr.key, independentKey);
  assert.equal((await request({ mode, clearKey: true })).asr.hasKey, false);
  assert.equal((await readSharedSettings(env, defaults)).asr.providers.volcengine.key, legacyKey);
});
