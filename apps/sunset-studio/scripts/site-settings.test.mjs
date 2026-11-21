import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createSettingsStore} from '../server/settings-store.mjs';
import {createStudioApi} from '../server/site-api.mjs';

const origin = 'https://studio.example';
const key = 'admin-key-for-test';
const env = {
  STUDIO_ADMIN_HASH: createHash('sha256').update(key).digest('hex'),
  STUDIO_RUNTIME_SECRET: '01'.repeat(32),
};

test('only a valid, unexpired administrator session can change API settings', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_studio_settings.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query) {
      const statement = sqlite.prepare(query);
      return {bind: (...values) => ({
        first: async () => statement.get(...values),
        run: async () => ({meta: {changes: statement.run(...values).changes}}),
      })};
    },
  };
  let time = Date.now();
  const make = () => createStudioApi({getStore: () => createSettingsStore(db, env.STUDIO_RUNTIME_SECRET), now: () => time});
  let handle = make();
  const get = (pathname, cookie = '') => handle(new Request(origin + pathname, {headers: {Cookie: cookie}}), env);
  const post = (pathname, data = {}, cookie = '', from = origin) => handle(new Request(origin + pathname, {
    method: 'POST', headers: {Origin: from, 'Content-Type': 'application/json', Cookie: cookie}, body: JSON.stringify(data),
  }), env);
  try {
    for (const route of ['/api/config', '/api/disconnect', '/api/test', '/api/fish/config', '/api/fish/disconnect', '/api/fish/cast']) {
      assert.equal((await post(route)).status, 401, route);
    }
    assert.equal((await post('/api/admin/unlock', {key: 'wrong'})).status, 401);
    assert.equal((await post('/api/admin/unlock', {key}, '', 'https://other.example')).status, 403);
    const unlocked = await post('/api/admin/unlock', {key});
    assert.equal(unlocked.status, 200);
    assert.doesNotMatch(await unlocked.text(), new RegExp(key));
    const session = unlocked.headers.get('Set-Cookie');
    assert.match(session, /; HttpOnly; SameSite=Strict; Secure$/);
    const cookie = session.split(';', 1)[0];

    const model = {model: 'sample-model', baseUrl: 'https://provider.example/v1', apiKey: 'model-key-for-test'};
    const saved = await post('/api/config', model, cookie);
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), new RegExp(model.apiKey));
    assert.equal((await post('/api/config', {...model, apiKey: '', baseUrl: 'https://different.example/v1'}, cookie)).status, 400);
    const fish = await post('/api/fish/config', {apiKey: 'fish-key-for-test', enabled: true}, cookie);
    assert.equal(fish.status, 200);
    assert.doesNotMatch(await fish.text(), /fish-key-for-test/);

    handle = make();
    const publicStatus = await (await get('/api/status')).json();
    assert.equal(publicStatus.configured, true);
    assert.equal('baseUrl' in publicStatus, false);
    assert.equal((await (await get('/api/status', cookie)).json()).model, model.model);
    assert.equal((await (await get('/api/fish/status')).json()).enabled, true);
    assert.equal((await post('/api/disconnect', {}, cookie.replace(/.$/, 'A'))).status, 401);
    const ciphertext = sqlite.prepare('SELECT encrypted_value FROM studio_settings').all();
    assert.doesNotMatch(JSON.stringify(ciphertext), /key-for-test/);
    const store = createSettingsStore(db, env.STUDIO_RUNTIME_SECRET);
    assert.equal(await store.write('model', 0, model), false);

    const locked = await post('/api/admin/lock', {}, cookie);
    assert.match(locked.headers.get('Set-Cookie'), /Max-Age=0/);
    time += 30 * 60 * 1000 + 1;
    assert.equal((await post('/api/disconnect', {}, cookie)).status, 401);
  } finally { sqlite.close(); }
});
