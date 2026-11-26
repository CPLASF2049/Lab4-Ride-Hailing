import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { login } from '../../common/auth.mjs';
import { createServer, HttpError } from '../../common/http.mjs';
import { createDispatch } from './service.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const available = driverId => ({ id: driverId, online: true, active_order_id: null, active_assignment_id: null });
function snapshot(orderId = 'order-1', status = 'MATCHING', version = 1, extra = {}) {
  return {
    id: orderId, rider_id: 'rider-1', status, version,
    origin: { id: 'fudan', name: '复旦大学邯郸校区', lat: 31.2989, lng: 121.5033 },
    destination: { id: 'bund', name: '外滩', lat: 31.24, lng: 121.49 },
    estimate: { distance_m: 8610, amount_cents: 2603 },
    driver_id: null, assignment_id: null, offer_id: null,
    created_at: new Date().toISOString(), arrived_at: null, started_at: null, finished_at: null,
    final_distance_m: null, final_amount_cents: null, failure_reason: null, ...extra,
  };
}

async function harness(t, options = {}) {
  const state = {
    drivers: [available('driver-2'), available('driver-1')],
    driverCalls: 0, failCalls: [], acceptCalls: [], failError: null, driverError: null,
    acceptStatus: 'ACCEPTED', driverHook: null,
    ...options.state,
  };
  const driverServer = createServer({ service: 'mock-driver', routes: [
    { method: 'GET', path: '/internal/drivers', role: 'INTERNAL', handler: async () => {
      state.driverCalls++;
      if (state.driverHook) await state.driverHook();
      if (state.driverError) throw state.driverError;
      return { drivers: state.drivers };
    } },
  ] });
  const orderServer = createServer({ service: 'mock-order', routes: [
    { method: 'POST', path: '/internal/orders/:id/fail-matching', role: 'INTERNAL', handler: ({ params, body }) => {
      state.failCalls.push({ order_id: params.id, ...body });
      if (state.failError) throw state.failError;
      return { order: snapshot(params.id, 'FAILED', 2, { failure_reason: body.reason }) };
    } },
    { method: 'POST', path: '/internal/orders/:id/accept', role: 'INTERNAL', handler: ({ params, body }) => {
      state.acceptCalls.push({ order_id: params.id, ...body });
      return { order: snapshot(params.id, state.acceptStatus, 2, body), preserved: 'upstream-body' };
    } },
  ] });
  const driverUrl = await listen(driverServer);
  const orderUrl = await listen(orderServer);
  t.after(() => new Promise(resolve => driverServer.close(resolve)));
  t.after(() => new Promise(resolve => orderServer.close(resolve)));
  const settings = { ...options, driverUrl, orderUrl };
  delete settings.state;
  let instance = createDispatch(settings);
  let baseUrl = await listen(instance.server);
  t.after(() => instance.close());

  async function request(endpoint, body, actor = 'internal') {
    const headers = { 'Content-Type': 'application/json' };
    if (actor === 'internal') headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
    else if (actor) headers.Authorization = `Bearer ${login(actor).token}`;
    const result = await fetch(baseUrl + endpoint, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  }
  let eventCounter = 0;
  return {
    state, request,
    get service() { return instance; },
    task(orderId = 'order-1') { return instance.db.prepare('SELECT * FROM dispatch_tasks WHERE order_id = ?').get(orderId); },
    offers(orderId = 'order-1') { return instance.db.prepare('SELECT * FROM offers WHERE order_id = ? ORDER BY created_at,id').all(orderId); },
    event(order, eventId = `event-${++eventCounter}`) {
      return request('/internal/events', { event_id: eventId, event_type: `ORDER_${order.status}`, aggregate_id: order.id,
        version: order.version, occurred_at: new Date().toISOString(), data: order });
    },
    tick() { return instance.tick(); },
    async restart() {
      await instance.close();
      instance = createDispatch(settings);
      baseUrl = await listen(instance.server);
    },
  };
}
const claimBody = (offer, assignment = 'assignment-1') => ({ order_id: offer.order_id, driver_id: offer.driver_id, assignment_id: assignment });

test('offers follow sorted driver IDs once each; rejects exhaust candidates without waiting forever', async t => {
  const h = await harness(t, { state: { drivers: [available('driver-2'), { ...available('driver-0'), online: false }, available('driver-1')] } });
  const order = snapshot();
  assert.equal((await h.event(order)).status, 200);
  assert.equal(h.state.driverCalls, 0, 'workers are disabled until explicitly started');
  await h.tick();
  const first = h.offers()[0];
  assert.equal(first.driver_id, 'driver-1');
  const visible = await h.request('/drivers/me/offers', undefined, 'driver-1');
  assert.equal(visible.body.offers.length, 1);
  assert.deepEqual(visible.body.offers[0].order, order);
  assert.deepEqual(visible.body.offers[0].origin, order.origin);
  assert.equal((await h.request(`/offers/${first.id}/reject`, {}, 'driver-2')).status, 403);
  assert.equal((await h.request(`/offers/${first.id}/accept`, {}, 'driver-2')).status, 403);
  assert.equal((await h.request('/drivers/me/offers', undefined, 'rider-1')).status, 403);
  assert.equal((await h.request(`/offers/${first.id}/reject`, {}, 'driver-1')).body.offer.status, 'REJECTED');
  assert.equal((await h.request(`/offers/${first.id}/reject`, {}, 'driver-1')).status, 409);
  await h.tick();
  const second = h.offers().find(offer => offer.status === 'PENDING');
  assert.equal(second.driver_id, 'driver-2');
  await h.request(`/offers/${second.id}/reject`, {}, 'driver-2');
  await h.tick();
  assert.deepEqual(h.state.failCalls, [{ order_id: order.id, reason: 'ALL_REJECTED' }]);
  assert.equal(h.task().state, 'FAILED');
  await h.tick();
  assert.equal(h.offers().length, 2);
  assert.equal(h.state.failCalls.length, 1);
});

test('no available driver fails immediately, and failed dependency calls retain retryable work', async t => {
  const h = await harness(t, { state: { drivers: [], driverError: new HttpError(503, 'DRIVER_DOWN', 'Unavailable') } });
  await h.event(snapshot());
  await h.tick();
  assert.equal(h.task().state, 'SEARCHING');
  assert.equal(h.state.failCalls.length, 0);
  assert.match(h.task().last_error, /DRIVER_DOWN/);
  h.state.driverError = null;
  h.state.failError = new HttpError(503, 'ORDER_DOWN', 'Unavailable');
  await h.tick();
  assert.equal(h.task().state, 'SEARCHING');
  assert.equal(h.state.failCalls[0].reason, 'NO_DRIVER');
  h.state.failError = new HttpError(409, 'ORDER_ASSIGNING', 'Saga is confirming');
  await h.tick();
  assert.equal(h.task().state, 'SEARCHING');
  h.state.failError = null;
  await h.tick();
  assert.equal(h.task().state, 'FAILED');
  assert.equal(h.state.failCalls.length, 3);
});

test('pending expiration advances once and the overall deadline produces MATCH_TIMEOUT', async t => {
  const h = await harness(t, { offerTtlMs: 20000, dispatchWaitMs: 45000 });
  await h.event(snapshot());
  await h.tick();
  const first = h.offers()[0];
  assert.ok(Date.parse(first.expires_at) <= Date.parse(h.task().deadline_at));
  h.service.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', first.id);
  await h.tick();
  assert.equal(h.offers().find(offer => offer.id === first.id).status, 'EXPIRED');
  const second = h.offers().find(offer => offer.status === 'PENDING');
  assert.equal(second.driver_id, 'driver-2');
  h.service.db.prepare('UPDATE dispatch_tasks SET deadline_at = ? WHERE order_id = ?').run('2000-01-01T00:00:00.000Z', 'order-1');
  await h.tick();
  assert.equal(h.state.failCalls.at(-1).reason, 'MATCH_TIMEOUT');
  assert.equal(h.task().state, 'FAILED');
  assert.equal(h.offers().find(offer => offer.id === second.id).status, 'CANCELLED');
});

test('claims bind identity atomically, survive restart and ignore elapsed offer/overall deadlines', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab3-dispatch-claim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await harness(t, { dbPath: path.join(directory, 'dispatch.sqlite') });
  await h.event(snapshot());
  await h.tick();
  const offer = h.offers()[0];
  const wrong = await h.request(`/internal/offers/${offer.id}/claim`, { ...claimBody(offer), driver_id: 'driver-2' });
  assert.equal(wrong.status, 409);
  assert.equal((await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer))).body.offer.status, 'CLAIMED');
  h.service.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', offer.id);
  h.service.db.prepare('UPDATE dispatch_tasks SET deadline_at = ? WHERE order_id = ?').run('2000-01-01T00:00:00.000Z', offer.order_id);
  await h.restart();
  await h.tick();
  assert.equal(h.task().state, 'CONFIRMING');
  assert.equal(h.state.failCalls.length, 0);
  assert.equal((await h.request('/drivers/me/offers', undefined, offer.driver_id)).body.offers[0].status, 'CLAIMED');
  assert.equal((await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer))).status, 200);
  assert.equal((await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer, 'other-assignment'))).status, 409);
  assert.equal((await h.request(`/offers/${offer.id}/reject`, {}, offer.driver_id)).status, 409);
  assert.equal((await h.request(`/internal/offers/${offer.id}/resolve`, { assignment_id: 'wrong', status: 'FAILED' })).status, 409);
  assert.equal((await h.request(`/internal/offers/${offer.id}/resolve`, { assignment_id: 'assignment-1', status: 'FAILED' })).status, 200);
  assert.equal(h.task().state, 'SEARCHING');
  assert.equal((await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer))).status, 409);
  await h.tick();
  assert.equal(h.state.failCalls.at(-1).reason, 'MATCH_TIMEOUT');
  await h.service.close();
});

test('inbox duplicate and stale versions cannot undo cancellation or resurrect matching', async t => {
  const h = await harness(t);
  const initial = snapshot();
  await h.event(initial, 'created-event');
  await h.tick();
  const cancelled = { ...initial, status: 'CANCELLED', version: 3 };
  assert.equal((await h.event(cancelled, 'cancelled-event')).body.applied, true);
  assert.equal((await h.event(cancelled, 'cancelled-event')).body.duplicate, true);
  assert.equal((await h.event({ ...initial, version: 2 }, 'stale-event')).body.applied, false);
  await h.event({ ...initial, version: 4 }, 'invalid-resurrection-event');
  assert.equal(h.task().state, 'CANCELLED');
  assert.equal(h.task().version, 4);
  assert.equal(h.offers()[0].status, 'CANCELLED');
  assert.equal((await h.request('/drivers/me/offers', undefined, 'driver-1')).body.offers.length, 0);
  await h.tick();
  assert.equal(h.offers().length, 1);
  assert.equal(h.state.failCalls.length, 0);
  assert.equal(h.service.db.prepare('SELECT COUNT(*) AS n FROM dispatch_inbox').get().n, 4);
});

for (const terminal of ['CANCELLED', 'FAILED']) {
  test(`${terminal} before saga resolution invalidates a claim and resolution never resumes search`, async t => {
    const h = await harness(t);
    const order = snapshot();
    await h.event(order);
    await h.tick();
    const offer = h.offers()[0];
    await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer));
    await h.event({ ...order, status: terminal, version: 2 });
    assert.equal(h.offers()[0].status, 'CANCELLED');
    assert.equal((await h.request(`/internal/offers/${offer.id}/resolve`, { assignment_id: 'assignment-1', status: 'FAILED' })).status, 200);
    assert.equal(h.task().state, terminal);
    await h.tick();
    assert.equal(h.offers().length, 1);
    assert.equal(h.state.failCalls.length, 0);
  });
}

test('accepted event may arrive before resolve, and repeats remain harmless after original expiry', async t => {
  const h = await harness(t);
  const order = snapshot();
  await h.event(order);
  await h.tick();
  const offer = h.offers()[0];
  await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer));
  await h.event({ ...order, status: 'ACCEPTED', version: 3, offer_id: offer.id, driver_id: offer.driver_id, assignment_id: 'assignment-1' });
  h.service.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', offer.id);
  assert.equal((await h.request(`/internal/offers/${offer.id}/resolve`, { assignment_id: 'assignment-1', status: 'ACCEPTED' })).status, 200);
  assert.equal((await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer))).status, 200);
  assert.equal((await h.event({ ...order, status: 'ASSIGNING', version: 2 })).body.applied, false);
  assert.equal(h.task().state, 'COMPLETED');
  assert.equal(h.offers()[0].status, 'ACCEPTED');
  const accepted = await h.request(`/offers/${offer.id}/accept`, {}, offer.driver_id);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.preserved, 'upstream-body');
  await h.tick();
  assert.equal(h.state.failCalls.length, 0);
});

test('failed saga resolution resumes searching only after newer MATCHING projection', async t => {
  const h = await harness(t);
  const order = snapshot();
  await h.event(order);
  await h.tick();
  const offer = h.offers()[0];
  await h.event({ ...order, status: 'ASSIGNING', version: 2 });
  await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer));
  await h.request(`/internal/offers/${offer.id}/resolve`, { assignment_id: 'assignment-1', status: 'FAILED' });
  await h.tick();
  assert.equal(h.offers().length, 1);
  await h.event({ ...order, status: 'MATCHING', version: 3 });
  await h.tick();
  assert.equal(h.offers().length, 2);
  assert.equal(h.offers().find(row => row.status === 'PENDING').driver_id, 'driver-2');
});

test('expired claim rejection commits EXPIRED and tried drivers persist across restart', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab3-dispatch-tried-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await harness(t, { dbPath: path.join(directory, 'dispatch.sqlite') });
  await h.event(snapshot());
  await h.tick();
  const offer = h.offers()[0];
  h.service.db.prepare('UPDATE offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', offer.id);
  const expired = await h.request(`/internal/offers/${offer.id}/claim`, claimBody(offer));
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, 'OFFER_EXPIRED');
  assert.equal(h.offers()[0].status, 'EXPIRED');
  await h.restart();
  await h.tick();
  assert.equal(h.offers().length, 2);
  assert.equal(h.offers().find(row => row.status === 'PENDING').driver_id, 'driver-2');
  await h.service.close();
});

test('accept forwards identity and upstream body, including asynchronous 202 confirmation', async t => {
  const h = await harness(t, { state: { acceptStatus: 'ASSIGNING' } });
  await h.event(snapshot());
  await h.tick();
  const offer = h.offers()[0];
  const pending = await h.request(`/offers/${offer.id}/accept`, {}, offer.driver_id);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.order.status, 'ASSIGNING');
  assert.equal(pending.body.preserved, 'upstream-body');
  assert.deepEqual(h.state.acceptCalls[0], { order_id: offer.order_id, driver_id: offer.driver_id, offer_id: offer.id });
});

test('overlapping worker ticks share one execution and do not produce duplicate offers', async t => {
  const h = await harness(t);
  let release;
  let notifyStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  h.state.driverHook = async () => { notifyStarted(); await gate; };
  await h.event(snapshot());
  const firstTick = h.tick();
  await started;
  await h.tick();
  assert.equal(h.state.driverCalls, 1);
  release();
  await firstTick;
  assert.equal(h.offers().length, 1);
});
