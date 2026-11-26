import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { login } from '../../common/auth.mjs';
import { httpJson, HttpError } from '../../common/http.mjs';
import { createOrder } from '../order/service.mjs';
import { createDriver } from '../driver/service.mjs';
import { createPricing } from '../pricing/service.mjs';
import { createDispatch } from './service.mjs';

async function listen(service) {
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  return `http://127.0.0.1:${service.server.address().port}`;
}

async function request(base, endpoint, { body, actor, method = body === undefined ? 'GET' : 'POST', key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Authorization = `Bearer ${login(actor).token}`;
  else headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
  if (key) headers['Idempotency-Key'] = key;
  const result = await fetch(base + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, body: await result.json() };
}

async function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab3-cross-service-race-'));
  const driver = createDriver({ dbPath: path.join(directory, 'driver.sqlite') });
  const pricing = createPricing({ dbPath: path.join(directory, 'pricing.sqlite') });
  const driverUrl = await listen(driver);
  const pricingUrl = await listen(pricing);
  let dispatch;
  let dispatchUrl;
  let order;
  let orderUrl;
  const faults = { claim: null, reserve: null, resolve: null, blockMatching: false };
  const actual = {
    claim: payload => httpJson(`${dispatchUrl}/internal/offers/${payload.offer_id}/claim`, { method: 'POST', body: payload }),
    reserve: payload => httpJson(`${driverUrl}/internal/drivers/${payload.driver_id}/reserve`, { method: 'POST', body: payload }),
    resolve: payload => httpJson(`${dispatchUrl}/internal/offers/${payload.offer_id}/resolve`, { method: 'POST', body: payload }),
  };
  const clients = {
    getEstimate: estimateId => httpJson(`${pricingUrl}/internal/estimates/${estimateId}`),
    getOffer: offerId => httpJson(`${dispatchUrl}/internal/offers/${offerId}`),
    claimOffer: payload => faults.claim ? faults.claim(payload) : actual.claim(payload),
    reserveDriver: payload => faults.reserve ? faults.reserve(payload) : actual.reserve(payload),
    releaseDriver: payload => httpJson(`${driverUrl}/internal/drivers/${payload.driver_id}/release`, { method: 'POST', body: payload }),
    resolveOffer: payload => faults.resolve ? faults.resolve(payload) : actual.resolve(payload),
    calculateFare: payload => httpJson(`${pricingUrl}/internal/fare`, { method: 'POST', body: payload }),
    publish: async (destination, event) => {
      if (destination !== 'dispatch') return { received: true };
      if (faults.blockMatching && event.data.status === 'MATCHING' && event.version > 1) {
        throw new HttpError(503, 'INJECTED_EVENT_DELAY', '模拟新的匹配事件延迟');
      }
      return httpJson(`${dispatchUrl}/internal/events`, { method: 'POST', body: event });
    },
  };
  function makeOrder() { return createOrder({ dbPath: path.join(directory, 'order.sqlite'), clients }); }
  function makeDispatch() { return createDispatch({ dbPath: path.join(directory, 'dispatch.sqlite'), orderUrl, driverUrl }); }
  order = makeOrder();
  orderUrl = await listen(order);
  dispatch = makeDispatch();
  dispatchUrl = await listen(dispatch);
  t.after(async () => {
    await dispatch.close();
    await order.close();
    await pricing.close();
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const driverId of ['driver-1', 'driver-2']) {
    const result = await request(driverUrl, '/drivers/me/status', { actor: driverId, method: 'PUT', body: { online: true } });
    assert.equal(result.status, 200);
  }

  async function drainOrder() {
    order.db.prepare("UPDATE jobs SET next_attempt_at = 0 WHERE status = 'PENDING'").run();
    order.db.prepare('UPDATE outbox SET next_attempt_at = 0 WHERE delivered_at IS NULL').run();
    await order.tick();
  }
  return {
    faults, actual,
    get order() { return order; }, get driver() { return driver; }, get dispatch() { return dispatch; },
    task(orderId) { return dispatch.db.prepare('SELECT * FROM dispatch_tasks WHERE order_id = ?').get(orderId); },
    offers(orderId) { return dispatch.db.prepare('SELECT * FROM offers WHERE order_id = ? ORDER BY created_at,id').all(orderId); },
    drainOrder,
    async create() {
      const quote = await request(pricingUrl, '/orders/estimate', { actor: 'rider-1', body: { origin_id: 'fudan', destination_id: 'bund' } });
      const created = await request(orderUrl, '/orders', { actor: 'rider-1', key: 'race-order-create', body: { estimate_id: quote.body.estimate.id } });
      assert.equal(created.status, 201);
      await drainOrder();
      await dispatch.tick();
      return created.body.order;
    },
    accept(offer) { return request(dispatchUrl, `/offers/${offer.id}/accept`, { actor: offer.driver_id, body: {} }); },
    cancel(orderId) { return request(orderUrl, `/orders/${orderId}/cancel`, { actor: 'rider-1', body: {} }); },
    setOnline(online) { return request(driverUrl, '/drivers/me/status', { actor: 'driver-1', method: 'PUT', body: { online } }); },
    async projectCurrent(orderId) {
      const current = order.repository.get(orderId);
      const event = order.db.prepare("SELECT payload FROM outbox WHERE destination = 'dispatch'").all()
        .map(row => JSON.parse(row.payload)).find(value => value.aggregate_id === orderId && value.version === current.version);
      assert.ok(event);
      await clients.publish('dispatch', event);
    },
    async restartOrderAndDispatch() {
      await dispatch.close();
      await order.close();
      order = makeOrder();
      orderUrl = await listen(order);
      dispatch = makeDispatch();
      dispatchUrl = await listen(dispatch);
    },
  };
}

test('cross-service: ASSIGNING projected before an expired claim recovers when durable MATCHING event retries', async t => {
  const f = await fixture(t);
  const order = await f.create();
  const offer = f.offers(order.id)[0];
  f.faults.blockMatching = true;
  f.faults.claim = async payload => {
    await f.projectCurrent(order.id); // Project ASSIGNING before the failing claim RPC.
    f.dispatch.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', offer.id);
    return f.actual.claim(payload);
  };
  const result = await f.accept(offer);
  assert.equal(result.body.order.status, 'MATCHING');
  assert.equal(result.body.order.last_assignment_failure, 'OFFER_EXPIRED');
  assert.equal(f.task(order.id).state, 'CONFIRMING');
  assert.equal(f.task(order.id).version, 2);
  assert.equal(f.offers(order.id)[0].status, 'EXPIRED');
  await f.drainOrder(); // The unbound claim resolve returns 409, which Order treats as harmless.
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get().n, 0);
  assert.ok(f.order.db.prepare("SELECT 1 FROM outbox WHERE destination = 'dispatch' AND delivered_at IS NULL").get());
  await f.dispatch.tick();
  assert.equal(f.offers(order.id).length, 1, 'saga confirmation is not expired locally');
  f.faults.blockMatching = false;
  await f.drainOrder();
  assert.equal(f.task(order.id).state, 'SEARCHING');
  await f.dispatch.tick();
  assert.equal(f.offers(order.id).find(row => row.status === 'PENDING').driver_id, 'driver-2');
  assert.equal(f.task(order.id).version, 3);
});

test('cross-service: reserve committed but response lost recovers after restart, offline and both deadlines', async t => {
  const f = await fixture(t);
  const order = await f.create();
  const offer = f.offers(order.id)[0];
  let loseResponse = true;
  f.faults.reserve = async payload => {
    const result = await f.actual.reserve(payload);
    if (loseResponse) {
      loseResponse = false;
      throw new HttpError(503, 'INJECTED_RESPONSE_LOST', '模拟预占成功后响应丢失');
    }
    return result;
  };
  const first = await f.accept(offer);
  assert.equal(first.status, 202);
  assert.equal(first.body.order.status, 'ASSIGNING');
  const assignmentId = first.body.order.assignment_id;
  await f.projectCurrent(order.id);
  await f.setOnline(false);
  f.dispatch.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', offer.id);
  f.dispatch.db.prepare('UPDATE dispatch_tasks SET deadline_at = ? WHERE order_id = ?').run('2000-01-01T00:00:00.000Z', order.id);
  await f.restartOrderAndDispatch();
  await f.dispatch.tick();
  assert.equal(f.task(order.id).state, 'CONFIRMING');
  await f.drainOrder();
  const accepted = f.order.repository.get(order.id);
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(accepted.assignment_id, assignmentId);
  assert.equal(f.driver.db.prepare('SELECT online FROM drivers WHERE id = ?').get(offer.driver_id).online, 0);
  assert.equal(f.driver.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE state = 'RESERVED'").get().n, 1);
  assert.equal(f.offers(order.id)[0].status, 'ACCEPTED');
  assert.equal(f.task(order.id).state, 'COMPLETED');
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM state_log WHERE status = 'ACCEPTED'").get().n, 1);
  await f.drainOrder();
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get().n, 0);
});

test('cross-service: cancellation release overtakes delayed reserve and its tombstone prevents occupation', async t => {
  const f = await fixture(t);
  const order = await f.create();
  const offer = f.offers(order.id)[0];
  let signalWaiting;
  let resumeReserve;
  const waiting = new Promise(resolve => { signalWaiting = resolve; });
  const gate = new Promise(resolve => { resumeReserve = resolve; });
  t.after(() => resumeReserve());
  f.faults.reserve = async payload => {
    signalWaiting(payload);
    await gate;
    return f.actual.reserve(payload);
  };
  const accepting = f.accept(offer);
  const payload = await waiting;
  const cancelled = await f.cancel(order.id);
  assert.equal(cancelled.body.order.status, 'CANCELLED');
  await f.drainOrder();
  assert.equal(f.driver.db.prepare('SELECT state FROM reservations WHERE assignment_id = ?').get(payload.assignment_id).state, 'RELEASED');
  assert.equal(f.offers(order.id)[0].status, 'CANCELLED');
  resumeReserve();
  const result = await accepting;
  assert.equal(result.body.order.status, 'CANCELLED');
  await f.drainOrder();
  assert.equal(f.driver.db.prepare('SELECT active_order_id FROM drivers WHERE id = ?').get(offer.driver_id).active_order_id, null);
  assert.equal(f.task(order.id).state, 'CANCELLED');
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get().n, 0);
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM state_log WHERE status = 'ACCEPTED'").get().n, 0);
});

test('cross-service: a delayed successful resolve after cancellation remains harmless and frees the driver', async t => {
  const f = await fixture(t);
  const order = await f.create();
  const offer = f.offers(order.id)[0];
  const accepted = await f.accept(offer);
  assert.equal(accepted.body.order.status, 'ACCEPTED');
  f.faults.resolve = async () => { throw new HttpError(503, 'INJECTED_RESOLVE_DELAY', '模拟派单结果确认延迟'); };
  await f.cancel(order.id);
  await f.drainOrder();
  assert.equal(f.task(order.id).state, 'CANCELLED');
  // ACCEPTED is historical once Order has published acceptance; the task and
  // public handler still prevent this completed offer from being used again.
  assert.equal(f.offers(order.id)[0].status, 'ACCEPTED');
  assert.equal((await f.accept(offer)).status, 409);
  assert.equal(f.driver.db.prepare('SELECT active_order_id FROM drivers WHERE id = ?').get(offer.driver_id).active_order_id, null);
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get().n, 1);
  f.faults.resolve = null;
  await f.drainOrder();
  await f.dispatch.tick();
  assert.equal(f.task(order.id).state, 'CANCELLED');
  assert.equal(f.offers(order.id).length, 1);
  assert.equal(f.order.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get().n, 0);
});
