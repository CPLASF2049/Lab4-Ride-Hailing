import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../services/gateway/service.mjs';
import { verify } from '../common/auth.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('Gateway HTTP boundary and service routing', async t => {
  const stubs = [];
  const seen = [];
  const options = {};
  for (const name of ['order', 'query', 'driver', 'dispatch', 'pricing']) {
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ service: name, path: req.url, method: req.method, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/orders/lag')) {
        res.statusCode = 202;
        res.end(JSON.stringify({ order: null, sync_pending: true }));
      } else if (req.url === '/orders/conflict/cancel') {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: { code: 'CONFLICT', message: '状态不允许操作' }, request_id: 'upstream-id' }));
      } else {
        res.end(JSON.stringify({ service: name, path: req.url, method: req.method }));
      }
    });
    await listen(server);
    stubs.push(server);
    options[`${name}Url`] = `http://127.0.0.1:${server.address().port}`;
  }
  const gateway = createGateway(options);
  await listen(gateway.server);
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  async function request(path, options = {}, expectedStatus = 200) {
    const res = await fetch(base + path, options);
    assert.equal(res.status, expectedStatus, `${options.method || 'GET'} ${path}`);
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
    return { res, data };
  }
  async function login(id) {
    const { data } = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ account_id: id }) });
    return { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' };
  }
  try {
    await t.test('health is local and public accounts contain no authentication secrets', async () => {
      await request('/health');
      assert.equal(seen.length, 0);
      const { data } = await request('/api/auth/accounts');
      assert.equal(data.accounts.length, 4);
      for (const account of data.accounts) assert.deepEqual(Object.keys(account).sort(), ['id', 'name', 'role']);
      assert.deepEqual(data.accounts.map(account => account.name), ['陈同学', '李同学', '王师傅', '赵师傅']);
      const health = (await request('/api/system/health')).data;
      assert.equal(Object.keys(health.services).length, 5);
      assert.equal(JSON.stringify(health).includes('http:'), false);
    });

    await t.test('login issues shared signed tokens and role checks reject unauthenticated or wrong-role requests', async () => {
      const { data } = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ account_id: 'rider-1' }) });
      assert.equal(verify(data.token).id, 'rider-1');
      await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ account_id: 'intruder' }) }, 400);
      await request('/api/orders/current', {}, 401);
      await request('/api/orders/current', { headers: { Authorization: 'Bearer tampered' } }, 401);
      await request('/api/drivers/me/status', { method: 'PUT', headers: { Authorization: `Bearer ${data.token}` }, body: '{}' }, 403);
      const driver = await login('driver-1');
      await request('/api/orders/history', { headers: driver }, 403);
    });

    await t.test('public paths reach the correct backend and only allowed headers cross the boundary', async () => {
      const rider = await login('rider-1');
      const driver = await login('driver-1');
      const key = '11111111-1111-4111-8111-111111111111';
      assert.equal((await request('/api/places')).data.service, 'pricing');
      assert.equal((await request('/api/orders/estimate', { method: 'POST', headers: rider, body: '{}' })).data.service, 'pricing');
      assert.equal((await request('/api/orders', {
        method: 'POST', body: '{"estimate_id":"estimate_1"}',
        headers: { ...rider, 'Idempotency-Key': key, 'X-Internal-Token': 'must-not-pass' },
      })).data.service, 'order');
      assert.equal(seen.at(-1).headers.authorization, rider.Authorization);
      assert.equal(seen.at(-1).headers['idempotency-key'], key);
      assert.equal(seen.at(-1).headers['x-internal-token'], undefined);
      assert.equal(seen.at(-1).body, '{"estimate_id":"estimate_1"}');
      assert.equal((await request('/api/orders/current', { headers: rider })).data.service, 'query');
      assert.equal((await request('/api/orders/history', { headers: rider })).data.service, 'query');
      assert.equal((await request('/api/drivers/me', { headers: driver })).data.service, 'driver');
      assert.equal((await request('/api/drivers/me/offers', { headers: driver })).data.service, 'dispatch');
      assert.equal((await request('/api/offers/offer_1/accept', { method: 'POST', headers: driver, body: '{}' })).data.service, 'dispatch');
    });

    await t.test('lagging projections and business errors preserve status, query string and JSON body', async () => {
      const rider = await login('rider-1');
      const lag = await request('/api/orders/lag?min_version=5', { headers: rider }, 202);
      assert.equal(lag.data.sync_pending, true);
      assert.equal(seen.at(-1).path, '/orders/lag?min_version=5');
      const conflict = await request('/api/orders/conflict/cancel', { method: 'POST', headers: rider, body: '{}' }, 409);
      assert.equal(conflict.data.error.code, 'CONFLICT');
      assert.equal(conflict.data.request_id, 'upstream-id');
    });

    await t.test('internal routes, unknown assets and path traversal are inaccessible', async () => {
      const rider = await login('rider-1');
      const countBefore = seen.length;
      await request('/api/internal/drivers/driver-1', { headers: rider }, 404);
      await request('/api/orders/x/internal', { headers: rider }, 404);
      await request('/api/orders/x/cancel', { method: 'DELETE', headers: rider }, 405);
      await request('/common/auth.mjs', {}, 404);
      assert.equal(seen.length, countBefore);
      // fetch normalizes dot segments; raw HTTP deliberately preserves the attack path.
      const traversalStatus = await new Promise((resolve, reject) => {
        const req = http.request(base, { path: '/vendor/%2e%2e/%2e%2e/common/auth.mjs' }, res => {
          res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject); req.end();
      });
      assert.equal(traversalStatus, 400);
    });

    await t.test('frontend assets are local, version-pinned, correctly typed and protected by a CSP', async () => {
      const page = await request('/');
      assert.match(page.data, /沪行/);
      assert.match(page.res.headers.get('content-security-policy'), /script-src 'self'/);
      assert.match((await request('/app.js')).data, /sessionStorage/);
      assert.match((await request('/styles.css')).res.headers.get('content-type'), /text\/css/);
      assert.match((await request('/vendor/leaflet/leaflet.js')).data, /1\.9\.4/);
      assert.match((await request('/vendor/leaflet/LICENSE')).data, /Copyright/);
      const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    });

    await t.test('invalid JSON is rejected before being proxied', async () => {
      const rider = await login('rider-1');
      const countBefore = seen.length;
      await request('/api/auth/login', { method: 'POST', body: '{' }, 400);
      await request('/api/orders', { method: 'POST', headers: rider, body: '{' }, 400);
      assert.equal(seen.length, countBefore);
    });
  } finally {
    await gateway.close();
    await Promise.all(stubs.map(close));
  }
});
