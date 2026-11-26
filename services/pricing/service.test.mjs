import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { login } from '../../common/auth.mjs';
import { createPricing, calculateFare, places } from './service.mjs';

async function start(t, options = {}) {
  const service = createPricing(options);
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const url = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => service.close());
  async function request(endpoint, body, actor = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (actor === 'internal') headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
    else if (actor) headers.Authorization = `Bearer ${login(actor).token}`;
    const result = await fetch(url + endpoint, { method: body ? 'POST' : 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  }
  return { ...service, request };
}

const trip = { origin_id: 'fudan', destination_id: 'bund' };

test('Shanghai WGS84 presets generate persistent estimated quotes tied to the rider', async t => {
  const service = await start(t);
  const presets = await service.request('/places');
  assert.equal(presets.body.places.length, 6);
  assert.deepEqual(presets.body.places.find(place => place.id === 'fudan'), places[0]);
  assert.equal((await service.request('/orders/estimate', trip)).status, 401);
  assert.equal((await service.request('/orders/estimate', trip, 'driver-1')).status, 403);
  const result = await service.request('/orders/estimate', trip, 'rider-1');
  assert.equal(result.status, 200);
  const { estimate } = result.body;
  assert.equal(estimate.rider_id, 'rider-1');
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.distance_method, 'haversine_x_1_3');
  assert.ok(estimate.distance_m > 8000 && estimate.distance_m < 9000);
  assert.equal(estimate.amount_cents, calculateFare(estimate.distance_m));
  assert.equal(Date.parse(estimate.expires_at) - Date.parse(estimate.created_at), 300000);
  assert.ok(Number.isInteger(estimate.duration_s));
  assert.deepEqual((await service.request(`/internal/estimates/${estimate.id}`, undefined, 'internal')).body.estimate, estimate);
});

test('quote validation rejects unknown or identical places and fare inputs are bounded integer meters', async t => {
  const service = await start(t);
  for (const body of [{}, { ...trip, origin_id: 'outside-shanghai' }, { origin_id: 'bund', destination_id: 'bund' }]) {
    assert.equal((await service.request('/orders/estimate', body, 'rider-1')).status, 400);
  }
  const { estimate } = (await service.request('/orders/estimate', trip, 'rider-2')).body;
  assert.equal((await service.request('/internal/fare', { estimate_id: 'missing', distance_m: 3000 }, 'internal')).status, 404);
  for (const distance of [0, -1, 1.2, '3000', 200001, null]) {
    assert.equal((await service.request('/internal/fare', { estimate_id: estimate.id, distance_m: distance }, 'internal')).status, 400);
  }
  for (const [distance, amount] of [[1, 1200], [3000, 1200], [4000, 1450], [10001, 2950], [200000, 50450]]) {
    const fare = await service.request('/internal/fare', { estimate_id: estimate.id, distance_m: distance }, 'internal');
    assert.equal(fare.status, 200);
    assert.equal(fare.body.amount_cents, amount);
    assert.ok(Number.isInteger(fare.body.amount_cents));
  }
});

test('expired estimates survive restart and remain usable for an existing ride final fare', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab3-pricing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'pricing.sqlite');
  let service = await start(t, { dbPath });
  const { estimate } = (await service.request('/orders/estimate', trip, 'rider-1')).body;
  service.db.prepare('UPDATE estimates SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', estimate.id);
  await service.close();
  service = await start(t, { dbPath });
  const loaded = await service.request(`/internal/estimates/${estimate.id}`, undefined, 'internal');
  assert.equal(loaded.body.estimate.expires_at, '2000-01-01T00:00:00.000Z');
  const fare = await service.request('/internal/fare', { estimate_id: estimate.id, distance_m: 5000 }, 'internal');
  assert.equal(fare.body.amount_cents, 1700);
  await service.close();
});
