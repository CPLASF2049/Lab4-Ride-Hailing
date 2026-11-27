import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRegistry } from '../services/registry/service.mjs';
import { createOrder } from '../services/order/service.mjs';
import { createQuery } from '../services/query/service.mjs';
import { createGateway } from '../services/gateway/service.mjs';
import { Order } from '../services/order/domain/order.mjs';
import { Discovery } from '../common/discovery.mjs';
import { registerInstance } from '../common/registration.mjs';
import { listen, request, sampleEstimate, testDirectory } from './helpers.mjs';

test('New read replica bootstraps its private projection from Order API, not from Order DB', async t => {
  const directory = testDirectory(t);
  const registry = createRegistry({ dbPath: ':memory:' });
  const registryBase = await listen(registry);

  const noCalls = new Proxy({}, { get: () => async () => { throw new Error('not used'); } });
  const orderService = createOrder({ dbPath: path.join(directory, 'order.sqlite'), clients: noCalls });
  const orderBase = await listen(orderService);
  t.after(() => orderService.close());

  const root = Order.create({ id: 'order-bootstrap', riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() });
  root.beginAssignment('driver-1', 'offer-bootstrap', 'asg-bootstrap', new Date().toISOString());
  root.confirmAssignment('asg-bootstrap', new Date().toISOString());
  orderService.repository.create(root, 'bootstrap-key', 'hash');
  const registration = await registerInstance({ registryUrl: registryBase, service: 'order', port: orderService.server.address().port, address: '127.0.0.1', heartbeatMs: 500 });

  const driverStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ driver: { id: 'driver-1', name: '王师傅', vehicle: { plate: '沪A·L3101' }, online: true } }));
  });
  await new Promise(resolve => driverStub.listen(0, '127.0.0.1', resolve));
  const driverRegistration = await registerInstance({ registryUrl: registryBase, service: 'driver', port: driverStub.address().port, address: '127.0.0.1', heartbeatMs: 500 });
  t.after(async () => {
    await driverRegistration.stop();
    await registration.stop();
    await new Promise(resolve => driverStub.close(resolve));
    await registry.close();
  });

  const query = createQuery({ dbPath: path.join(directory, 'query.sqlite'), registryUrl: registryBase, driverUrl: `http://127.0.0.1:${driverStub.address().port}` });
  const queryBase = await listen(query);
  t.after(() => query.close());
  query.start();

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = query.bootstrap.state === 'READY';
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, JSON.stringify(query.bootstrap));
  assert.equal(query.bootstrap.orders, 1);

  const detail = await request(queryBase, '/orders/order-bootstrap');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.order.id, 'order-bootstrap');
  assert.equal(detail.body.driver?.name, '王师傅', JSON.stringify(detail.body));
  assert.equal(query.db.prepare('SELECT COUNT(*) AS n FROM order_views').get().n, 1);
});

test('Scale-out skips an unready replica and reconciles writes omitted by a cached catalog', { timeout: 8000 }, async t => {
  const registry = createRegistry({ dbPath: ':memory:' });
  const registryBase = await listen(registry);
  const catalog = () => request(registryBase, '/v1/catalog/order-query');
  const orderDiscovery = new Discovery({ registryUrl: registryBase, ttlMs: 60_000 });
  const order = createOrder({ dbPath: ':memory:', discovery: orderDiscovery });
  const orderBase = await listen(order);
  const existing = createQuery({ dbPath: ':memory:', registryUrl: registryBase, requireBootstrap: true, replicaSyncMs: 60_000 });
  const existingBase = await listen(existing);
  const snapshotRead = Promise.withResolvers();
  const resumeBootstrap = Promise.withResolvers();
  const replicaDiscovery = new Discovery({ registryUrl: registryBase });
  const requestOrder = replicaDiscovery.request.bind(replicaDiscovery);
  replicaDiscovery.request = async (service, route, options) => {
    const result = await requestOrder(service, route, options);
    if (route === '/internal/orders/snapshots') {
      snapshotRead.resolve(result.data.cursor);
      await resumeBootstrap.promise;
    }
    return result;
  };
  const replica = createQuery({ dbPath: ':memory:', discovery: replicaDiscovery, requireBootstrap: true, replicaSyncMs: 150 });
  const replicaBase = await listen(replica);
  const gateway = createGateway({ discovery: new Discovery({ registryUrl: registryBase, ttlMs: 0 }) });
  const gatewayBase = await listen(gateway);
  const ids = ['scale-order', 'scale-query-ready', 'scale-query-new'];
  const register = (id, service, server) => request(registryBase, '/v1/instances/' + id, {
    method: 'PUT', internal: true, body: { service, address: '127.0.0.1', port: server.address().port, ttl_ms: 10000 },
  });
  const deregister = id => request(registryBase, '/v1/instances/' + id, { method: 'DELETE', internal: true });
  t.after(async () => {
    resumeBootstrap.resolve();
    await Promise.all(ids.map(deregister));
    await Promise.all([replica.close(), existing.close(), gateway.close()]);
    await order.close();
    await registry.close();
  });
  assert.equal((await register(ids[0], 'order', order.server)).status, 200);
  assert.equal((await register(ids[1], 'order-query', existing.server)).status, 200);
  const root = Order.create({ id: 'order-during-scale', riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() });
  order.repository.create(root, 'scale-order-key', 'hash');
  existing.start();
  const bootstrapRequest = { method: 'POST', internal: true };
  assert.equal((await request(existingBase, '/internal/bootstrap', bootstrapRequest)).body.state, 'READY');
  assert.equal((await catalog()).body.count, 1);
  assert.deepEqual((await orderDiscovery.list('order-query')).map(instance => instance.id), [ids[1]]);

  assert.equal((await register(ids[2], 'order-query', replica.server)).status, 200);
  assert.equal((await catalog()).body.count, 2);
  replica.start();
  const snapshotCursor = await snapshotRead.promise;
  const detailPath = '/orders/' + root.data.id;
  assert.equal((await request(replicaBase, '/health')).status, 503);
  assert.equal((await request(replicaBase, '/orders/history')).body.error.code, 'QUERY_BOOTSTRAPPING');
  assert.equal((await request(replicaBase, '/orders/current')).status, 503);
  assert.equal((await request(replicaBase, detailPath)).status, 503);
  const whileStarting = await request(gatewayBase, '/api' + detailPath);
  assert.equal(whileStarting.status, 200);
  assert.equal(whileStarting.body.order.status, 'MATCHING');

  const cancel = await request(orderBase, detailPath + '/cancel', { method: 'POST' });
  assert.equal(cancel.status, 200);
  const rider2 = Order.create({ id: 'order-created-during-scale', riderId: 'rider-2', estimate: sampleEstimate('rider-2'), at: new Date().toISOString() });
  order.repository.create(rider2, 'scale-order-key-2', 'hash');
  await order.tick();
  assert.equal(order.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='query' AND delivered_at IS NULL").get().n, 0);
  assert.equal((await request(existingBase, detailPath)).body.order.status, 'CANCELLED');
  assert.equal(replica.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);

  resumeBootstrap.resolve();
  let caughtUp = false;
  for (let attempt = 0; attempt < 40 && !caughtUp; attempt++) {
    const result = await request(replicaBase, detailPath + '?min_version=' + cancel.body.order.version);
    caughtUp = result.status === 200 && result.body.order.status === 'CANCELLED';
    if (!caughtUp) await delay(50);
  }
  assert.ok(caughtUp, JSON.stringify(replica.bootstrap));
  assert.equal(replica.bootstrap.state, 'READY');
  assert.ok(replica.bootstrap.cursor > snapshotCursor);
  const newOrder = await request(replicaBase, '/orders/' + rider2.data.id, { actor: 'rider-2' });
  assert.equal(newOrder.status, 200);
  assert.equal(newOrder.body.order.id, rider2.data.id);
  assert.equal((await request(replicaBase, '/health')).status, 200);
  assert.equal(replica.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);

  await deregister(ids[2]);
  assert.equal((await catalog()).body.count, 1);
  assert.equal((await request(gatewayBase, '/api' + detailPath)).body.order.status, 'CANCELLED');
});

test('Order snapshot cursor reads bounded pages and deduplicates successive versions within a page', async t => {
  const service = createOrder({ dbPath: ':memory:' });
  const base = await listen(service);
  t.after(() => service.close());
  const endpoint = '/internal/orders/snapshots';
  const internal = { internal: true };
  const empty = await request(base, endpoint, internal);
  assert.equal(empty.body.cursor, 0);
  assert.deepEqual(empty.body.orders, []);
  assert.equal((await request(base, endpoint + '?after=-1', internal)).body.error.code, 'INVALID_CURSOR');
  for (let index = 1; index <= 101; index++) {
    const root = Order.create({ id: 'paged-order-' + index, riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() });
    service.repository.create(root, 'snapshot-key-' + index, 'hash');
    service.app.cancel(root.data.id, 'rider-1');
  }
  const first = (await request(base, endpoint + '?after=' + empty.body.cursor, internal)).body;
  assert.equal(first.orders.length, 100);
  assert.equal(first.cursor, 200);
  assert.ok(first.orders.every(order => order.status === 'CANCELLED'));
  const second = (await request(base, endpoint + '?after=' + first.cursor, internal)).body;
  assert.equal(second.cursor, 202);
  assert.deepEqual(second.orders.map(order => order.id), ['paged-order-101']);
  const done = (await request(base, endpoint + '?after=' + second.cursor, internal)).body;
  assert.equal(done.cursor, second.cursor);
  assert.deepEqual(done.orders, []);
});
