import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../services/registry/service.mjs';
import { listen, request } from './helpers.mjs';

const instance = (service, id, port = 4000) => ({ service, address: '127.0.0.1', port, ttl_ms: 10000 });

test('Registry: register, refresh, catalog and deregister update discovery results', async t => {
  const registry = createRegistry({ dbPath: ':memory:' });
  const base = await listen(registry);
  t.after(() => registry.close());

  assert.equal((await request(base, '/v1/catalog', { actor: null })).body.services.order, undefined);
  const put = await request(base, '/v1/instances/order-1', { method: 'PUT', internal: true, body: instance('order', 'order-1', 3101) });
  assert.equal(put.status, 200);
  assert.equal(put.body.instance.id, 'order-1');

  let catalog = await request(base, '/v1/catalog/order', { actor: null });
  assert.equal(catalog.body.count, 1);
  assert.deepEqual(catalog.body.instances[0], {
    id: 'order-1', service: 'order', address: '127.0.0.1', port: 3101,
    last_seen: catalog.body.instances[0].last_seen, age_ms: catalog.body.instances[0].age_ms,
  });

  const conflict = await request(base, '/v1/instances/order-1', { method: 'PUT', internal: true, body: instance('order', 'order-1', 9999) });
  assert.equal(conflict.status, 409);

  const bad = await request(base, '/v1/instances/bad', { method: 'PUT', internal: true, body: { service: 'Bad Name', address: 'x', port: 1 } });
  assert.equal(bad.status, 400);

  const removed = await request(base, '/v1/instances/order-1', { method: 'DELETE', internal: true });
  assert.equal(removed.body.deregistered, true);
  catalog = await request(base, '/v1/catalog/order', { actor: null });
  assert.equal(catalog.body.count, 0);
});

test('Registry: registration requires the internal token and leases expire without heartbeats', async t => {
  const registry = createRegistry({ dbPath: ':memory:' });
  const base = await listen(registry);
  t.after(() => registry.close());

  assert.equal((await request(base, '/v1/instances/x', { method: 'PUT', body: instance('driver', 'x', 3103) })).status, 401);
  await request(base, '/v1/instances/stale', { method: 'PUT', internal: true, body: { ...instance('driver', 'stale', 3103), ttl_ms: 2000 } });
  assert.equal((await request(base, '/v1/catalog/driver', { actor: null })).body.count, 1);
  const stored = registry.live.get('stale');
  stored.last_seen = Date.now() - 5000;
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal((await request(base, '/v1/catalog/driver', { actor: null })).body.count, 0);
});
