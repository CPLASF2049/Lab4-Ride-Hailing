import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRegistry } from '../services/registry/service.mjs';
import { Discovery } from '../common/discovery.mjs';
import { listen, request } from './helpers.mjs';

function stub(id) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Instance': id });
    res.end(JSON.stringify({ served_by: id }));
  });
  return server;
}

test('Discovery: resolves all instances, load balances, and fails over to a live replica', async t => {
  const registry = createRegistry({ dbPath: ':memory:' });
  const registryBase = await listen(registry);
  const servers = [stub('demo-a'), stub('demo-b')];
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await registry.close();
  });
  const [first, second] = servers.map(server => server.address().port);
  await request(registryBase, '/v1/instances/demo-0', { method: 'PUT', internal: true, body: { service: 'demo', address: '127.0.0.1', port: 9, ttl_ms: 10000 } });
  await request(registryBase, '/v1/instances/demo-a', { method: 'PUT', internal: true, body: { service: 'demo', address: '127.0.0.1', port: first, ttl_ms: 10000 } });
  await request(registryBase, '/v1/instances/demo-b', { method: 'PUT', internal: true, body: { service: 'demo', address: '127.0.0.1', port: second, ttl_ms: 10000 } });

  const discovery = new Discovery({ registryUrl: registryBase, ttlMs: 500 });
  const list = await discovery.list('demo');
  assert.deepEqual(list.map(item => item.id), ['demo-0', 'demo-a', 'demo-b']);

  const seen = [];
  for (let i = 0; i < 4; i++) seen.push((await discovery.request('demo', '/profile')).data.served_by);
  assert.deepEqual(new Set(seen), new Set(['demo-a', 'demo-b']));
  assert.ok(discovery.stats.failovers >= 1, 'unreachable demo-0 should be skipped');

  await request(registryBase, '/v1/instances/demo-a', { method: 'DELETE', internal: true });
  await new Promise(resolve => setTimeout(resolve, 600));
  const after = await discovery.list('demo');
  assert.deepEqual(after.map(item => item.id), ['demo-0', 'demo-b']);

  const missing = new Discovery({ registryUrl: registryBase });
  await assert.rejects(() => missing.request('absent', '/x'), error => error.code === 'NO_INSTANCE');
});

test('Discovery: static fallback keeps component tests independent of a registry', async () => {
  const discovery = new Discovery({ staticUrls: { pricing: 'http://127.0.0.1:3105' } });
  const list = await discovery.list('pricing');
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'http://127.0.0.1:3105');
  assert.equal(discovery.stats.fallback_static, 1);
});
