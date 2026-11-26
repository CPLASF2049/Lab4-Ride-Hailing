import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createOrder } from '../services/order/service.mjs';
import { HttpError } from '../common/http.mjs';
import { listen, request, sampleEstimate, testDirectory } from './helpers.mjs';

function dependencies() {
  const state = { occupied: null, reserveCalls: 0, fareCalls: 0, published: [], releaseFails: false };
  return {
    state,
    getEstimate: async id => ({ estimate: sampleEstimate(id.endsWith('rider-2') ? 'rider-2' : 'rider-1') }),
    getOffer: async id => ({ offer: { id, order_id: state.orderId, driver_id: 'driver-1', status: 'PENDING', expires_at: new Date(Date.now() + 15000).toISOString() } }),
    claimOffer: async () => ({}),
    reserveDriver: async p => { state.reserveCalls++; state.occupied = p; return { reserved: true }; },
    releaseDriver: async p => {
      if (state.releaseFails) throw new HttpError(503, 'DRIVER_DOWN', 'down');
      if (state.occupied?.assignment_id === p.assignment_id) state.occupied = null;
      return { released: true };
    },
    resolveOffer: async () => ({}),
    calculateFare: async p => { state.fareCalls++; return { distance_m: p.distance_m, amount_cents: 2700 }; },
    publish: async (destination, event) => { state.published.push({ destination, event }); return {}; },
  };
}
async function fixture(t, overrides = {}) {
  const dir = testDirectory(t); const clients = dependencies(); Object.assign(clients, overrides);
  let service = createOrder({ dbPath: path.join(dir, 'order.sqlite'), clients });
  let base = await listen(service);
  t.after(async () => { await service.close(); });
  return {
    clients, get service() { return service; }, get base() { return base; },
    async restart() { await service.close(); service = createOrder({ dbPath: path.join(dir, 'order.sqlite'), clients }); base = await listen(service); },
    async create(rider = 'rider-1', key = 'creation-001') {
      const res = await request(base, '/orders', { method: 'POST', actor: rider, key, body: { estimate_id: `estimate-${rider}` } });
      assert.equal(res.status, 201, JSON.stringify(res.body)); clients.state.orderId = res.body.order.id; return res.body.order;
    },
    async accept(order) {
      return request(base, `/internal/orders/${order.id}/accept`, { method: 'POST', internal: true, body: { driver_id: 'driver-1', offer_id: 'offer-1' } });
    },
    async drain() {
      service.db.prepare("UPDATE jobs SET next_attempt_at=0 WHERE status='PENDING'").run();
      service.db.prepare('UPDATE outbox SET next_attempt_at=0 WHERE delivered_at IS NULL').run();
      await service.tick();
    },
  };
}

test('Component: authenticated create, isolated DB persistence, transactional outbox and permissions', async t => {
  const f = await fixture(t); const order = await f.create();
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 2);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM state_log').get().n, 1);
  assert.equal((await request(f.base, '/orders', { method: 'POST', actor: null, body: {} })).status, 401);
  assert.equal((await request(f.base, `/orders/${order.id}/cancel`, { method: 'POST', actor: 'rider-2' })).status, 403);
  assert.equal((await request(f.base, `/orders/${order.id}/start`, { method: 'POST', actor: 'driver-2' })).status, 403);
  assert.equal((await request(f.base, `/internal/orders/${order.id}`, { actor: null })).status, 401);
  await f.restart(); assert.deepEqual(f.service.repository.get(order.id), order);
});
test('Component: request key replay creates one order and a new key cannot bypass one active order', async t => {
  const f = await fixture(t); const order = await f.create();
  const repeated = await request(f.base, '/orders', { method: 'POST', key: 'creation-001', body: { estimate_id: 'estimate-rider-1' } });
  assert.equal(repeated.body.order.id, order.id);
  assert.equal((await request(f.base, '/orders', { method: 'POST', key: 'creation-001', body: { estimate_id: 'another-quote' } })).status, 409);
  assert.equal((await request(f.base, '/orders', { method: 'POST', key: 'different-key', body: { estimate_id: 'estimate-rider-1' } })).status, 409);
  await request(f.base, `/orders/${order.id}/cancel`, { method: 'POST' });
  const next = await f.create('rider-1', 'creation-002'); assert.notEqual(next.id, order.id);
});
test('Component: lifecycle retries preserve timestamps and fare; failed release resumes after restart', async t => {
  const f = await fixture(t); const order = await f.create();
  const accepted = await f.accept(order); assert.equal(accepted.body.order.status, 'ACCEPTED');
  assert.equal((await f.accept(order)).body.order.version, accepted.body.order.version);
  assert.equal(f.clients.state.reserveCalls, 1);
  assert.equal((await request(f.base, `/orders/${order.id}/start`, { method: 'POST', actor: 'driver-1' })).status, 409);
  await request(f.base, `/orders/${order.id}/arrive`, { method: 'POST', actor: 'driver-1' });
  const started = await request(f.base, `/orders/${order.id}/start`, { method: 'POST', actor: 'driver-1' });
  const startAgain = await request(f.base, `/orders/${order.id}/start`, { method: 'POST', actor: 'driver-1' });
  assert.equal(started.body.order.started_at, startAgain.body.order.started_at);
  assert.equal((await request(f.base, `/orders/${order.id}/cancel`, { method: 'POST' })).status, 409);
  f.clients.state.releaseFails = true;
  const completed = await request(f.base, `/orders/${order.id}/finish`, { method: 'POST', actor: 'driver-1', body: { distance_m: 9000 } });
  const repeated = await request(f.base, `/orders/${order.id}/finish`, { method: 'POST', actor: 'driver-1', body: { distance_m: 1 } });
  assert.equal(completed.body.order.status, 'COMPLETED'); assert.deepEqual(completed.body.order, repeated.body.order);
  assert.equal(f.clients.state.fareCalls, 1);
  await f.drain();
  assert.ok(f.service.db.prepare("SELECT 1 FROM jobs WHERE type='RELEASE_DRIVER' AND status='PENDING'").get());
  assert.ok(f.clients.state.occupied);
  await f.restart(); f.clients.state.releaseFails = false; await f.drain();
  assert.equal(f.clients.state.occupied, null);
  assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='PENDING'").get().n, 0);
});
test('Component: lost successful reserve response is retried from persisted progress after restart', async t => {
  const f = await fixture(t); const order = await f.create();
  const reserve = f.clients.reserveDriver;
  f.clients.reserveDriver = async p => { await reserve(p); throw new HttpError(503, 'RESPONSE_LOST', 'response lost after commit'); };
  const first = await f.accept(order); assert.equal(first.status, 202); assert.equal(first.body.order.status, 'ASSIGNING');
  assert.ok(f.clients.state.occupied); const assignment = f.clients.state.occupied.assignment_id;
  await f.restart(); f.clients.reserveDriver = reserve; await f.drain();
  const final = f.service.repository.get(order.id);
  assert.equal(final.status, 'ACCEPTED'); assert.equal(final.assignment_id, assignment);
  assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM state_log WHERE status='ACCEPTED'").get().n, 1);
});
test('Component: cancelling while reservation is in flight wins over late order confirmation', async t => {
  const f = await fixture(t); const order = await f.create();
  let markReserved; const reserved = new Promise(resolve => { markReserved = resolve; });
  let acknowledge; const responseReleased = new Promise(resolve => { acknowledge = resolve; });
  f.clients.reserveDriver = async p => { f.clients.state.occupied = p; markReserved(); await responseReleased; return {}; };
  const accepting = f.accept(order); await reserved;
  const cancelled = await request(f.base, `/orders/${order.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.body.order.status, 'CANCELLED');
  acknowledge(); const late = await accepting; assert.equal(late.body.order.status, 'CANCELLED');
  await f.drain(); assert.equal(f.clients.state.occupied, null);
  assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM state_log WHERE status='ACCEPTED'").get().n, 0);
});
test('Component: a rejected driver reservation restores matching with persisted compensation', async t => {
  const f = await fixture(t); const order = await f.create();
  f.clients.reserveDriver = async () => { throw new HttpError(409, 'DRIVER_OFFLINE', 'offline'); };
  const result = await f.accept(order);
  assert.equal(result.body.order.status, 'MATCHING');
  assert.equal(result.body.order.driver_id, null); assert.equal(result.body.order.assignment_id, null);
  assert.equal(result.body.order.last_assignment_failure, 'DRIVER_OFFLINE');
  assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='PENDING'").get().n, 2);
  await f.drain(); assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='PENDING'").get().n, 0);
});
test('Component: database rollback prevents state without its outbox event', async t => {
  const f = await fixture(t); const order = await f.create();
  f.service.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'simulated disk transaction failure'); END;");
  const result = await request(f.base, `/orders/${order.id}/cancel`, { method: 'POST' });
  assert.equal(result.status, 500); assert.equal(f.service.repository.get(order.id).status, 'MATCHING');
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM state_log').get().n, 1);
});
test('Component: concurrent cancel and start yield exactly one legal outcome', async t => {
  const f = await fixture(t); const order = await f.create(); await f.accept(order);
  await request(f.base, `/orders/${order.id}/arrive`, { method: 'POST', actor: 'driver-1' });
  const results = await Promise.all([
    request(f.base, `/orders/${order.id}/cancel`, { method: 'POST' }),
    request(f.base, `/orders/${order.id}/start`, { method: 'POST', actor: 'driver-1' }),
  ]);
  const final = f.service.repository.get(order.id);
  assert.ok(['CANCELLED','IN_PROGRESS'].includes(final.status));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  if (final.status === 'CANCELLED') assert.equal(final.started_at, null);
  else assert.ok(final.started_at);
});
