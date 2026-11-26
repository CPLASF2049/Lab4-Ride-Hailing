import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRegistry } from '../services/registry/service.mjs';
import { createOrder } from '../services/order/service.mjs';
import { createQuery } from '../services/query/service.mjs';
import { Order } from '../services/order/domain/order.mjs';
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
