import assert from 'node:assert/strict';
import {makeServer} from '../server.mjs';

export async function studioFixture(options = {}) {
  const adminKey = 'test-admin-key';
  const server = makeServer({...options, adminKey, runtimeSecret: 'a'.repeat(64)});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie;
  const post = (route, data = {}, extra = {}) => fetch(base + route, {
    method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json', ...(cookie && {Cookie: cookie}), ...extra},
    body: JSON.stringify(data),
  });
  try {
    const unlock = await post('/api/admin/unlock', {key: adminKey});
    assert.equal(unlock.status, 200);
    cookie = unlock.headers.get('Set-Cookie').split(';', 1)[0];
    await unlock.body.cancel();
  } catch (error) {
    server.close();
    throw error;
  }
  const get = route => fetch(base + route, {headers: {Cookie: cookie}});
  return {server, base, get, post};
}
