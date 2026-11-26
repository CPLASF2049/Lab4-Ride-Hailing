import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRegistry } from '../services/registry/service.mjs';
import { createGateway } from '../services/gateway/service.mjs';
import { login } from '../common/auth.mjs';
import { listen, request } from './helpers.mjs';

function queryStub(id) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Instance': id });
    res.end(JSON.stringify({ order: { id: 'ord-demo', status: 'ACCEPTED' }, driver: { id: 'driver-1' }, served_by: id }));
  });
  return server;
}

test('Gateway: routes /api/orders by service discovery and fails over between read replicas', async t => {
  const registry = createRegistry({ dbPath: ':memory:' });
  const registryBase = await listen(registry);
  const stubs = [queryStub('query-a'), queryStub('query-b')];
  await Promise.all(stubs.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  for (const [index, server] of stubs.entries()) {
    await request(registryBase, `/v1/instances/query-${index}`, {
      method: 'PUT', internal: true,
      body: { service: 'order-query', address: '127.0.0.1', port: server.address().port, ttl_ms: 10000 },
    });
  }
  const gateway = createGateway({ registryUrl: registryBase, timeoutMs: 2000 });
  const base = await listen(gateway);
  t.after(async () => {
    await gateway.close();
    await Promise.all(stubs.map(server => new Promise(resolve => server.close(resolve))));
    await registry.close();
  });

  const token = login('rider-1').token;
  const served = [];
  for (let i = 0; i < 4; i++) {
    const response = await fetch(base + '/api/orders/ord-demo', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.ok(['query-a', 'query-b'].includes(response.headers.get('x-instance')));
    served.push(response.headers.get('x-instance'));
  }
  assert.deepEqual(new Set(served), new Set(['query-a', 'query-b']));

  await request(registryBase, '/v1/instances/query-0', { method: 'DELETE', internal: true });
  await new Promise(resolve => setTimeout(resolve, 1800));
  for (let i = 0; i < 3; i++) {
    const response = await fetch(base + '/api/orders/ord-demo', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.headers.get('x-instance'), 'query-b');
  }

  const anonymous = await fetch(base + '/api/orders/ord-demo');
  assert.equal(anonymous.status, 401);
  const internal = await fetch(base + '/api/internal/resilience');
  assert.equal(internal.status, 404);
});
