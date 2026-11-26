import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { login } from '../../common/auth.mjs';
import { createDriver } from './service.mjs';

async function start(t, options = {}) {
  const service = createDriver(options);
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const url = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => service.close());
  async function request(endpoint, body, actor = 'internal', method = body ? 'POST' : 'GET') {
    const headers = { 'Content-Type': 'application/json' };
    if (actor === 'internal') headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
    else if (actor) headers.Authorization = `Bearer ${login(actor).token}`;
    const result = await fetch(url + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  }
  return { ...service, request };
}

const reservation = (order = 'order-1', assignment = 'assignment-1') => ({ order_id: order, assignment_id: assignment });
const setOnline = (service, id = 'driver-1', online = true) => service.request('/drivers/me/status', { online }, id, 'PUT');

test('drivers begin offline; status validates role and boolean while preserving occupation', async t => {
  const service = await start(t);
  assert.equal((await service.request('/drivers/me', undefined, 'driver-1')).body.driver.online, false);
  assert.equal((await service.request('/drivers/me', undefined, 'rider-1')).status, 403);
  assert.equal((await service.request('/internal/drivers', undefined, null)).status, 401);
  assert.equal((await service.request('/drivers/me/status', { online: 'yes' }, 'driver-1', 'PUT')).status, 400);
  assert.equal((await service.request('/internal/drivers/driver-1/reserve', reservation())).body.error.code, 'DRIVER_OFFLINE');
  await setOnline(service);
  const first = await service.request('/internal/drivers/driver-1/reserve', reservation());
  assert.equal(first.status, 200);
  const offline = await setOnline(service, 'driver-1', false);
  assert.equal(offline.body.driver.online, false);
  assert.equal(offline.body.driver.active_order_id, 'order-1');
  // A successful reserve can replay after the driver has gone offline.
  assert.equal((await service.request('/internal/drivers/driver-1/reserve', reservation())).status, 200);
  const released = await service.request('/internal/drivers/driver-1/release', reservation());
  assert.equal(released.body.driver.active_order_id, null);
  assert.equal(released.body.driver.online, false);
});

test('reservation races enforce one active order per driver and one driver per order', async t => {
  const service = await start(t);
  await setOnline(service);
  await setOnline(service, 'driver-2');
  const results = await Promise.all([
    service.request('/internal/drivers/driver-1/reserve', reservation('order-a', 'assignment-a')),
    service.request('/internal/drivers/driver-1/reserve', reservation('order-b', 'assignment-b')),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200).body.driver;
  const conflict = await service.request('/internal/drivers/driver-2/reserve', reservation(winner.active_order_id, 'assignment-c'));
  assert.equal(conflict.status, 409);
  assert.equal((await service.request('/internal/drivers/driver-2')).body.driver.active_order_id, null);
});

test('release-before-reserve tombstones and conditional old releases survive restart', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab3-driver-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'driver.sqlite');
  let service = await start(t, { dbPath });
  await setOnline(service);
  assert.equal((await service.request('/internal/drivers/driver-1/release', reservation('cancelled', 'late'))).status, 200);
  await service.close();
  service = await start(t, { dbPath });
  const late = await service.request('/internal/drivers/driver-1/reserve', reservation('cancelled', 'late'));
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'RESERVATION_RELEASED');
  assert.equal((await service.request('/internal/drivers/driver-1/reserve', reservation('new-order', 'new-assignment'))).status, 200);
  const oldRelease = await service.request('/internal/drivers/driver-1/release', reservation('cancelled', 'late'));
  assert.equal(oldRelease.body.driver.active_order_id, 'new-order');
  assert.equal(oldRelease.body.driver.active_assignment_id, 'new-assignment');
  const mismatched = await service.request('/internal/drivers/driver-2/release', reservation('cancelled', 'late'));
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.body.error.code, 'ASSIGNMENT_CONFLICT');
  await service.close();
});
