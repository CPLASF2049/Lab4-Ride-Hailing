import test from 'node:test';
import assert from 'node:assert/strict';
import { Order } from '../services/order/domain/order.mjs';
import { OrderApplication } from '../services/order/application/order-service.mjs';
import { HttpError } from '../common/http.mjs';

const T = '2026-11-15T10:00:00.000Z';
const estimate = { id: 'est-1', rider_id: 'rider-1', origin: { id: 'fudan', name: '复旦大学' }, destination: { id: 'bund', name: '外滩' }, distance_m: 7800, amount_cents: 2400, expires_at: '2026-11-15T10:05:00.000Z' };
function fresh() { return Order.create({ id: 'ord-1', riderId: 'rider-1', estimate, at: T }); }
function accepted() { const root = fresh(); root.beginAssignment('driver-1', 'offer-1', 'asg-1', T); root.confirmAssignment('asg-1', T); return root; }
const hasCode = code => e => e instanceof HttpError && e.code === code;

test('Order aggregate preserves the full lifecycle and first effective timestamps', () => {
  const root = accepted();
  root.arrive('driver-1', T); root.start('driver-1', T);
  assert.equal(root.start('driver-1', '2026-11-15T10:03:00Z'), false);
  assert.equal(root.data.started_at, T);
  root.finish('driver-1', { distance_m: 8100, amount_cents: 2475 }, T);
  const sealed = structuredClone(root.data);
  assert.equal(root.finish('driver-1', { distance_m: 1, amount_cents: 1 }, 'later'), false);
  assert.deepEqual(root.data, sealed); assert.equal(root.data.status, 'COMPLETED');
});
test('Order enforces owner, assigned driver, and state restrictions', () => {
  const root = accepted();
  assert.throws(() => root.cancel('rider-2', T), hasCode('NOT_YOUR_ORDER'));
  assert.throws(() => root.arrive('driver-2', T), hasCode('NOT_YOUR_ORDER'));
  assert.throws(() => root.start('driver-1', T), hasCode('INVALID_STATE'));
  assert.throws(() => root.finish('driver-1', { distance_m: 100, amount_cents: 1200 }, T), hasCode('INVALID_STATE'));
});
test('Cancellation remains allowed after acceptance and arrival, never after boarding', () => {
  for (const stage of ['MATCHING','ASSIGNING','ACCEPTED','ARRIVED']) {
    const root = fresh();
    if (stage !== 'MATCHING') root.beginAssignment('driver-1', 'offer-1', 'asg-1', T);
    if (['ACCEPTED','ARRIVED'].includes(stage)) root.confirmAssignment('asg-1', T);
    if (stage === 'ARRIVED') root.arrive('driver-1', T);
    root.cancel('rider-1', T); assert.equal(root.data.status, 'CANCELLED');
    assert.equal(root.cancel('rider-1', 'later'), false);
    assert.equal(root.data.cancelled_at, T);
  }
  const riding = accepted(); riding.arrive('driver-1', T); riding.start('driver-1', T);
  assert.throws(() => riding.cancel('rider-1', T), hasCode('TRIP_ALREADY_STARTED'));
});
test('Cancelled assignment cannot be revived by a late confirmation', () => {
  const root = fresh(); root.beginAssignment('driver-1', 'offer-1', 'asg-1', T);
  root.cancel('rider-1', T);
  assert.equal(root.confirmAssignment('asg-1', T), false);
  assert.equal(root.data.status, 'CANCELLED');
  assert.throws(() => root.beginAssignment('driver-2', 'offer-2', 'asg-2', T), hasCode('ORDER_UNAVAILABLE'));
});
test('Only the current assignment can succeed or be rejected', () => {
  const root = fresh(); root.beginAssignment('driver-1', 'offer-1', 'asg-1', T);
  assert.equal(root.confirmAssignment('old-assignment', T), false);
  assert.equal(root.rejectAssignment('old-assignment', 'DRIVER_BUSY', T), false);
  root.rejectAssignment('asg-1', 'DRIVER_OFFLINE', T);
  root.beginAssignment('driver-2', 'offer-2', 'asg-2', T);
  assert.equal(root.confirmAssignment('asg-1', T), false);
  root.confirmAssignment('asg-2', T); assert.equal(root.data.driver_id, 'driver-2');
});
test('Aggregate rejects invalid fare values and does not alter metering', () => {
  const root = accepted(); root.arrive('driver-1', T); root.start('driver-1', T);
  for (const fare of [{ distance_m: -1, amount_cents: 100 }, { distance_m: 100, amount_cents: NaN }]) {
    assert.throws(() => root.finish('driver-1', fare, T), hasCode('INVALID_FARE'));
    assert.equal(root.data.status, 'IN_PROGRESS');
  }
});
function fakeRepo() {
  const requests = new Map(); const orders = new Map();
  return {
    findRequest(rider, key, hash) {
      const old = requests.get(`${rider}:${key}`);
      if (old && old.hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'conflict');
      return old ? orders.get(old.id) : null;
    },
    create(root, key, hash) {
      orders.set(root.data.id, root.data); requests.set(`${root.data.rider_id}:${key}`, { hash, id: root.data.id }); return root.data;
    },
  };
}
test('Application retries creation with the same operation key without another pricing call', async () => {
  let calls = 0;
  const app = new OrderApplication({ repository: fakeRepo(), clients: { getEstimate: async () => { calls++; return { estimate }; } }, clock: () => T });
  const a = await app.create('rider-1', { estimate_id: 'est-1' }, 'request-001');
  const b = await app.create('rider-1', { estimate_id: 'est-1' }, 'request-001');
  assert.equal(a.id, b.id); assert.equal(calls, 1);
  await assert.rejects(() => app.create('rider-1', { estimate_id: 'est-2' }, 'request-001'), hasCode('IDEMPOTENCY_CONFLICT'));
});
test('Application validates quote ownership, expiry, and request identifier before creating', async () => {
  const app = new OrderApplication({ repository: fakeRepo(), clients: { getEstimate: async () => ({ estimate }) }, clock: () => T });
  await assert.rejects(() => app.create('rider-1', { estimate_id: 'est-1' }, ''), hasCode('IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(() => app.create('rider-2', { estimate_id: 'est-1' }, 'request-001'), hasCode('NOT_YOUR_ESTIMATE'));
  app.clock = () => '2026-11-15T10:06:00.000Z';
  await assert.rejects(() => app.create('rider-1', { estimate_id: 'est-1' }, 'request-001'), hasCode('ESTIMATE_EXPIRED'));
});
