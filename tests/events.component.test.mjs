import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuery } from '../services/query/service.mjs';
import { createDispatch } from '../services/dispatch/service.mjs';
import { Order } from '../services/order/domain/order.mjs';
import { listen, request, sampleEstimate } from './helpers.mjs';

for (const [name, create, inbox, projection] of [
  ['Query', createQuery, 'inbox', 'order_views'],
  ['Dispatch', createDispatch, 'dispatch_inbox', 'dispatch_tasks'],
]) {
  test(`${name}: invalid event envelopes cannot consume an event id or poison a projection`, async t => {
    const service = create({ dbPath: ':memory:' });
    t.after(() => service.close());
    const base = await listen(service);
    const order = Order.create({ id: 'ord-event', riderId: 'rider-1', estimate: sampleEstimate(), at: new Date().toISOString() }).data;
    const valid = { event_id: 'evt-retry', event_type: 'order.created.v1', aggregate_id: order.id, version: 1, occurred_at: order.created_at, data: order };
    const invalid = [
      { ...valid, event_id: '' },
      { ...valid, event_id: '   ' },
      { ...valid, aggregate_id: '' },
      { ...valid, event_type: 'driver.changed.v1' },
      { ...valid, event_type: undefined },
      { ...valid, occurred_at: 'not-a-date' },
      { ...valid, occurred_at: undefined },
      { ...valid, version: 2 },
      { ...valid, data: [] },
      { ...valid, data: { ...order, rider_id: '' } },
      { ...valid, data: { ...order, driver_id: {} } },
      { ...valid, data: { ...order, created_at: 'not-a-date' } },
    ];
    for (const body of invalid) {
      const result = await request(base, '/internal/events', { method: 'POST', internal: true, body });
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'INVALID_EVENT');
      assert.equal(service.db.prepare(`SELECT COUNT(*) AS n FROM ${inbox}`).get().n, 0);
      assert.equal(service.db.prepare(`SELECT COUNT(*) AS n FROM ${projection}`).get().n, 0);
    }
    const applied = await request(base, '/internal/events', { method: 'POST', internal: true, body: valid });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.applied, true);
    const duplicate = await request(base, '/internal/events', { method: 'POST', internal: true, body: valid });
    assert.equal(duplicate.body.duplicate, true);
  });
}
