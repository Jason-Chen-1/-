import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { readSharedSettings, sharedSettingsStatus } from '../worker/voice-settings.mjs';
import { settingsDefaults } from './runtime-config.mjs';
import { createSettings } from './settings.mjs';

const model = 'Qwen-Image-2.1-Turbo';
const publicModel = { model, modelLabel: 'Qwen-Image 2.1 Turbo', aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'] };
const environmentKey = 'amd-fixture-env-key';
const savedKey = 'amd-fixture-saved-key';

test('Node image settings retain, replace and clear the key without exposing it in status', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'studio-image-settings-'));
  const filename = path.join(directory, '.env');
  t.after(() => { rmSync(filename, { force: true }); rmdirSync(directory); });
  const settings = createSettings(filename, { AMD_CREATIVE_HUB_API_KEY: environmentKey });

  assert.deepEqual(settings.status().image, { mode: 'off', hasKey: true, available: false, ...publicModel });
  assert.deepEqual(settings.update({ image: { mode: 'amd', key: savedKey, model: 'unsupported-model' } }).image,
    { mode: 'amd', hasKey: true, available: true, ...publicModel });
  assert.deepEqual(settings.update({ image: { mode: 'off' } }).image, { mode: 'off', hasKey: true, available: false, ...publicModel });
  assert.deepEqual(settings.read().image, { mode: 'off', key: savedKey, model });
  assert.throws(() => settings.update({ image: { mode: 'invalid' } }), { statusCode: 400 });
  assert.deepEqual(settings.update({ image: { mode: 'amd', clearKey: true } }).image,
    { mode: 'amd', hasKey: false, available: false, ...publicModel });
  assert.deepEqual(settings.read().image, { mode: 'amd', key: '', model });
});

test('shared image settings require an administrator and use the existing encrypted D1 record', async t => {
  const studio = new Miniflare({
    modules: true, compatibilityDate: '2026-07-01', script: 'export default { fetch: () => new Response(null) };',
    d1Databases: { DB: 'studio-image-settings-fixture' },
  });
  t.after(() => studio.dispose());
  const database = await studio.getD1Database('DB');
  await database.prepare(readFileSync(new URL('../drizzle/0001_voice_settings.sql', import.meta.url), 'utf8').trim()).run();
  const admin = 'fixture-admin-key';
  const env = { DB: database, STUDIO_SETTINGS_SECRET: '9a'.repeat(32), STUDIO_SETTINGS_ADMIN_KEY: admin };
  const defaults = settingsDefaults({ STUDIO_IMAGE_MODE: 'amd', AMD_CREATIVE_HUB_API_KEY: environmentKey });
  const request = (key, input) => sharedSettingsStatus(new Request('https://studio.test/api/settings', {
    method: input ? 'POST' : 'GET', headers: key ? { 'X-Studio-Settings-Key': key } : {},
  }), env, defaults, async () => input);

  const publicStatus = await request();
  assert.deepEqual(publicStatus.image, { mode: 'amd', hasKey: true, available: true, ...publicModel });
  assert.deepEqual(publicStatus.writableServices, []);
  const saveImage = { image: { mode: 'amd', key: savedKey } };
  await assert.rejects(request(undefined, saveImage), { statusCode: 403 });
  await assert.rejects(request('wrong-fixture-key', saveImage), { statusCode: 403 });
  await assert.rejects(request(admin, { image: { mode: 'invalid' } }), { statusCode: 400 });
  await request(admin, { tts: { mode: 'fish', key: 'fish-fixture-key' } });
  const savedStatus = await request(admin, saveImage);
  assert.ok(savedStatus.writableServices.includes('image'));
  assert.deepEqual(savedStatus.image, publicStatus.image);

  const row = await database.prepare("SELECT iv, ciphertext FROM studio_voice_settings WHERE id='shared'").first();
  assert.ok(row.iv && row.ciphertext);
  assert.ok(!Buffer.from(row.ciphertext, 'base64').includes(savedKey));
  const effective = await readSharedSettings(env, defaults);
  assert.deepEqual(effective.image, { mode: 'amd', key: savedKey, model });
  assert.equal(effective.tts.key, 'fish-fixture-key');

  const disabled = await request(admin, { image: { mode: 'off' } });
  assert.deepEqual(disabled.image, { mode: 'off', hasKey: true, available: false, ...publicModel });
  assert.equal((await readSharedSettings(env, defaults)).image.key, savedKey);
  const cleared = await request(admin, { image: { mode: 'amd', clearKey: true } });
  assert.deepEqual(cleared.image, { mode: 'amd', hasKey: false, available: false, ...publicModel });
  assert.equal((await readSharedSettings(env, defaults)).image.key, '');
});
