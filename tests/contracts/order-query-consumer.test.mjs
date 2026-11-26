import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuery } from '../../services/query/service.mjs';
import { Order } from '../../services/order/domain/order.mjs';
import { listen, request, sampleEstimate, testDirectory } from '../helpers.mjs';
import { loadContract } from './contract-kit.mjs';

const contractFile = fileURLToPath(new URL('../../contracts/driver-profile.pact.json', import.meta.url));
const contract = loadContract(contractFile);
const profileInteraction = contract.interactions.find(item => item.response.status === 200);
const missingInteraction = contract.interactions.find(item => item.response.status === 404);

function seedOrder(service) {
  const order = Order.create({ id: 'order-contract', riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() });
  order.beginAssignment('driver-1', 'offer-contract', 'asg-contract', new Date().toISOString());
  order.confirmAssignment('asg-contract', new Date().toISOString());
  service.project({ event_id: 'seed-contract', event_type: 'order.changed.v1', aggregate_id: order.data.id, version: order.data.version, occurred_at: order.data.updated_at, data: order.data });
  return order.data;
}

async function startStub(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-internal-token'] || null });
    if (mode === 'missing') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(missingInteraction.response.body));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(profileInteraction.response.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

test('Consumer contract: order-query calls the agreed driver endpoint and composes its fields', async t => {
  const directory = testDirectory(t);
  const stub = await startStub('ok');
  t.after(() => new Promise(resolve => stub.server.close(resolve)));
  const service = createQuery({ dbPath: path.join(directory, 'query.sqlite'), driverUrl: stub.url, driverAttempts: 1 });
  const base = await listen(service);
  t.after(() => service.close());
  seedOrder(service);

  const result = await request(base, '/orders/order-contract');
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, false);
  assert.equal(result.body.driver.id, profileInteraction.response.body.driver.id);
  assert.equal(result.body.driver.name, profileInteraction.response.body.driver.name);
  assert.equal(result.body.driver.vehicle.plate, profileInteraction.response.body.driver.vehicle.plate);

  assert.equal(stub.seen.length >= 1, true);
  const call = stub.seen.at(-1);
  assert.equal(call.method, 'GET');
  assert.equal(call.url, profileInteraction.request.path);
  assert.equal(call.token, profileInteraction.request.headers['X-Internal-Token']);
});

test('Consumer contract: a provider 404 becomes an explicit partial response, not a crash', async t => {
  const directory = testDirectory(t);
  const stub = await startStub('missing');
  t.after(() => new Promise(resolve => stub.server.close(resolve)));
  const service = createQuery({ dbPath: path.join(directory, 'query.sqlite'), driverUrl: stub.url, driverAttempts: 1 });
  const base = await listen(service);
  t.after(() => service.close());
  seedOrder(service);

  const result = await request(base, '/orders/order-contract');
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.driver, null);
  assert.equal(result.body.warnings[0].code, 'DRIVER_UNAVAILABLE');
  assert.equal(result.body.order.id, 'order-contract');
});
