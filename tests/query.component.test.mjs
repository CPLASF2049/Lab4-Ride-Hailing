import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CircuitBreaker } from '../common/resilience.mjs';
import { createQuery } from '../services/query/service.mjs';
import { Order } from '../services/order/domain/order.mjs';
import { listen, request, sampleEstimate, testDirectory } from './helpers.mjs';

function event(order, eventId = `evt-${order.version}`) {
  return { event_id: eventId, event_type: 'order.changed.v1', aggregate_id: order.id, version: order.version, occurred_at: order.updated_at, data: order };
}
async function fixture(t) {
  const directory = testDirectory(t); let unavailable = false; let calls = 0;
  let service = createQuery({ dbPath: path.join(directory, 'query.sqlite'), getDriver: async id => { calls++; if (unavailable) throw new Error('down'); return { driver: { id, name: '真实司机服务档案', vehicle: { plate: '沪A·10001' } } }; } });
  let base = await listen(service); t.after(async () => service.close());
  return {
    get service() { return service; }, get base() { return base; }, get calls() { return calls; },
    setUnavailable(value) { unavailable = value; },
    async restart() { await service.close(); service = createQuery({ dbPath: path.join(directory, 'query.sqlite'), getDriver: async () => { throw new Error('down'); } }); base = await listen(service); },
  };
}
function snapshots() {
  const root = Order.create({ id: 'ord-projection', riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() });
  const created = structuredClone(root.data);
  root.beginAssignment('driver-1', 'offer-1', 'asg-1', new Date().toISOString());
  root.confirmAssignment('asg-1', new Date().toISOString());
  const accepted = structuredClone(root.data);
  root.arrive('driver-1', new Date().toISOString()); root.start('driver-1', new Date().toISOString());
  return { created, accepted, riding: root.data };
}

test('CQRS: full snapshot events tolerate duplicates, gaps, and older versions after newer state', async t => {
  const f = await fixture(t); const { created, accepted, riding } = snapshots();
  assert.deepEqual(f.service.project(event(riding)), { duplicate: false, applied: true });
  assert.deepEqual(f.service.project(event(riding)), { duplicate: true, applied: false });
  assert.deepEqual(f.service.project(event(created)), { duplicate: false, applied: false });
  assert.deepEqual(f.service.project(event(accepted)), { duplicate: false, applied: false });
  const result = await request(f.base, '/orders/ord-projection');
  assert.equal(result.body.order.status, 'IN_PROGRESS'); assert.equal(result.body.order.version, riding.version);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 3);
  await f.restart(); const recovered = await request(f.base, '/orders/ord-projection');
  assert.equal(recovered.body.order.version, riding.version);
});
test('CQRS: dependency failure keeps the persisted order and explicitly marks partial response', async t => {
  const f = await fixture(t); f.service.project(event(snapshots().accepted));
  const full = await request(f.base, '/orders/ord-projection');
  assert.equal(full.body.driver.name, '真实司机服务档案'); assert.equal(full.body.partial, false); assert.equal(f.calls, 1);
  f.setUnavailable(true); const partial = await request(f.base, '/orders/ord-projection');
  assert.equal(partial.status, 200); assert.equal(partial.body.order.status, 'ACCEPTED');
  assert.equal(partial.body.driver, null); assert.equal(partial.body.partial, true);
  assert.equal(partial.body.warnings[0].code, 'DRIVER_UNAVAILABLE');
});
test('CQRS: minimum version exposes sync delay without falsifying newer state', async t => {
  const f = await fixture(t); const { created, riding } = snapshots();
  const missing = await request(f.base, '/orders/ord-projection?min_version=5');
  assert.equal(missing.status, 202); assert.equal(missing.body.order, null); assert.equal(missing.body.sync_pending, true);
  f.service.project(event(created));
  const pending = await request(f.base, `/orders/ord-projection?min_version=${riding.version}`);
  assert.equal(pending.status, 202); assert.equal(pending.body.order.status, 'MATCHING'); assert.equal(pending.body.sync_pending, true);
  f.service.project(event(riding));
  assert.equal((await request(f.base, `/orders/ord-projection?min_version=${riding.version}`)).body.sync_pending, false);
});
test('CQRS: passenger and driver ownership plus history isolation are enforced at backend', async t => {
  const f = await fixture(t); f.service.project(event(snapshots().accepted));
  assert.equal((await request(f.base, '/orders/ord-projection', { actor: 'rider-2' })).status, 403);
  assert.equal((await request(f.base, '/orders/ord-projection', { actor: 'driver-2' })).status, 403);
  assert.equal((await request(f.base, '/orders/ord-projection', { actor: 'driver-1' })).status, 200);
  assert.equal((await request(f.base, '/orders/history', { actor: 'rider-2' })).body.orders.length, 0);
  assert.equal((await request(f.base, '/orders/history')).body.orders.length, 1);
  assert.equal((await request(f.base, '/internal/events', { method: 'POST', body: event(snapshots().riding), actor: null })).status, 401);
});
test('CQRS: malformed event rolls back without consuming its event id', async t => {
  const f = await fixture(t); const malformed = event(snapshots().accepted); malformed.version = 999;
  const res = await request(f.base, '/internal/events', { method: 'POST', body: malformed, internal: true });
  assert.equal(res.status, 400); assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM order_views').get().n, 0);
});

test('CQRS: malformed or mismatched driver profiles explicitly degrade the response', async t => {
  let driver = null;
  const breaker = new CircuitBreaker({ failureThreshold: 20 });
  const service = createQuery({ dbPath: ':memory:', breaker, driverAttempts: 1, getDriver: async () => ({ driver }) });
  t.after(() => service.close());
  const base = await listen(service);
  service.project(event(snapshots().accepted));
  for (driver of [null, undefined, { id: 'driver-2' }, []]) {
    const detail = await request(base, '/orders/ord-projection');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.order.status, 'ACCEPTED');
    assert.equal(detail.body.driver, null);
    assert.equal(detail.body.partial, true);
    assert.equal(detail.body.warnings[0].code, 'DRIVER_UNAVAILABLE');
    const current = await request(base, '/orders/current', { actor: 'driver-1' });
    assert.equal(current.status, 200);
    assert.equal(current.body.order.id, 'ord-projection');
    assert.equal(current.body.partial, true);
  }
});

test('CQRS: a missing occupancy field is not treated as an available driver with no order', async t => {
  const service = createQuery({ dbPath: ':memory:', driverAttempts: 1, getDriver: async id => ({ driver: { id } }) });
  t.after(() => service.close());
  const base = await listen(service);
  service.project(event(snapshots().accepted));
  const current = await request(base, '/orders/current', { actor: 'driver-1' });
  assert.equal(current.status, 200);
  assert.equal(current.body.order.id, 'ord-projection');
  assert.equal(current.body.driver, null);
  assert.equal(current.body.partial, true);
  assert.equal(current.body.warnings[0].code, 'DRIVER_UNAVAILABLE');
});

test('CQRS: driver fallback orders trips by creation time rather than unrelated aggregate versions', async t => {
  const service = createQuery({ dbPath: ':memory:', driverAttempts: 1, getDriver: async () => { throw new Error('down'); } });
  t.after(() => service.close());
  const base = await listen(service);
  const accepted = snapshots().accepted;
  service.project(event({ ...accepted, id: 'ord-old', version: 99, created_at: '2026-11-14T00:00:00.000Z' }, 'evt-old'));
  service.project(event({ ...accepted, id: 'ord-new', version: 3, created_at: '2026-11-15T00:00:00.000Z' }, 'evt-new'));
  const result = await request(base, '/orders/current', { actor: 'driver-1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.order.id, 'ord-new');
  assert.equal(result.body.partial, true);
});
