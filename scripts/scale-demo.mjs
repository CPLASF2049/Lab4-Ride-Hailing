import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:' + (process.env.GATEWAY_PORT || 8083);
const evidenceDir = path.resolve(root, process.env.LAB4_EVIDENCE_DIR || '.runtime/scale-demo');
const service = 'order-query';
const docker = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 90_000 }).trim();
const compose = args => docker(['compose', ...args]);
const adjust = (count, mode) => ['up', mode, '--no-deps', '--no-recreate', '--scale', service + '=' + count, service];

async function api(route, { method = 'GET', token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, data: await response.json(), instance: response.headers.get('X-Instance') };
}

async function expectStatus(route, status, options) {
  const result = await api(route, options);
  assert.equal(result.status, status, route + ' ' + (result.data.error?.code || ''));
  return result;
}

async function waitFor(description, check, timeout = 45_000) {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(350);
  } while (Date.now() < end);
  throw new Error('Timed out waiting for ' + description);
}

function containers() {
  const ids = compose(['ps', '--all', '--quiet', service]).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  return JSON.parse(docker(['inspect', ...ids])).map(({ Name, State }) => ({
    name: Name.replace(/^\//, ''), status: State.Status,
  }));
}

async function readyReplicas(count) {
  const { data } = await expectStatus('/api/system/health', 200);
  const state = data.services[service];
  if (state.instances !== count || state.checks.length !== count) return null;
  return state.checks.every(check => check.healthy && check.bootstrap_state === 'READY') ? state : null;
}

const instanceIds = state => state.checks.map(check => check.instance);

async function login(account) {
  return (await expectStatus('/api/auth/login', 200, { method: 'POST', body: { account_id: account } })).data.token;
}

const detail = ({ order, token }) => api('/api/orders/' + order.id + '?min_version=' + order.version, { token });
function observation(result) {
  return {
    instance: result.instance, http_status: result.status,
    order_id: result.data.order?.id, order_status: result.data.order?.status,
    order_version: result.data.order?.version,
  };
}
function reflects(result, order, expectedState) {
  return result.status === 200 && result.data.order?.id === order.id
    && result.data.order.version >= order.version
    && (!expectedState || result.data.order.status === expectedState);
}

async function observeEveryReplica(entry, ids, expectedState) {
  const seen = new Map();
  await waitFor('order ' + entry.order.id + ' on ' + ids.length + ' replica(s)', async () => {
    const result = await detail(entry);
    if (ids.includes(result.instance) && reflects(result, entry.order, expectedState)) {
      seen.set(result.instance, observation(result));
    }
    return seen.size === ids.length;
  });
  return [...seen.values()];
}

const createdOrders = [];
async function createOrder(token, origin_id, destination_id) {
  const quote = await expectStatus('/api/orders/estimate', 200, { method: 'POST', token, body: { origin_id, destination_id } });
  const created = await expectStatus('/api/orders', 201, {
    method: 'POST', token, key: randomUUID(), body: { estimate_id: quote.data.estimate.id },
  });
  const entry = { order: created.data.order, token };
  createdOrders.push(entry);
  return entry;
}

const cancel = ({ order, token }) => api('/api/orders/' + order.id + '/cancel', { method: 'POST', token });
const setOnline = (token, online) => expectStatus('/api/drivers/me/status', 200, { method: 'PUT', token, body: { online } });

async function seedAcceptedRide(rider, driver) {
  const entry = await createOrder(rider, 'fudan', 'bund');
  const offer = await waitFor('the seeded ride offer', async () => {
    const result = await expectStatus('/api/drivers/me/offers', 200, { token: driver });
    return result.data.offers.find(item => item.order_id === entry.order.id);
  }, 12_000);
  const accept = await api('/api/offers/' + offer.id + '/accept', { method: 'POST', token: driver });
  assert.ok([200, 202].includes(accept.status), 'The driver must be able to accept the seeded ride');
  await waitFor('the accepted ride in the original replica', async () => reflects(await detail(entry), entry.order, 'ACCEPTED'));
  return entry;
}

async function run() {
  const publishedPort = compose(['port', 'gateway', '8083']).split(':').at(-1);
  assert.equal(new URL(base).port, publishedPort, 'GATEWAY_URL must point at the selected Compose project');
  const before = await waitFor('one ready query replica', () => readyReplicas(1), 10_000);
  assert.equal(containers().length, 1, 'Start with exactly one query container');
  const [rider, secondRider, driver] = await Promise.all(['rider-1', 'rider-2', 'driver-1'].map(login));
  for (const token of [rider, secondRider]) {
    assert.equal((await expectStatus('/api/orders/current', 200, { token })).data.order, null, 'Demo riders must have no active orders');
  }
  const originalDriver = (await expectStatus('/api/drivers/me', 200, { token: driver })).data.driver;
  assert.equal(originalDriver.active_order_id, null, 'driver-1 must not already have an active ride');

  let restoreScale = false;
  let report;
  try {
    if (!originalDriver.online) await setOnline(driver, true);
    const seed = await seedAcceptedRide(rider, driver);

    restoreScale = true;
    compose(adjust(2, '--no-start'));
    const prepared = containers();
    assert.deepEqual(prepared.map(container => container.status).sort(), ['created', 'running']);

    const writes = await Promise.allSettled([createOrder(secondRider, 'fudan', 'people-square'), cancel(seed)]);
    for (const write of writes) if (write.status === 'rejected') throw write.reason;
    const created = writes[0].value;
    const cancelResult = writes[1].value;
    assert.equal(cancelResult.status, 200);
    assert.equal(cancelResult.data.order.status, 'CANCELLED');
    const cancelled = { order: cancelResult.data.order, token: rider };
    const originalDuringWrites = await observeEveryReplica(cancelled, instanceIds(before), 'CANCELLED');
    await observeEveryReplica(created, instanceIds(before));
    assert.deepEqual(containers().map(container => container.status).sort(), ['created', 'running']);

    compose(adjust(2, '-d'));
    const scaled = await waitFor('two ready query replicas', () => readyReplicas(2));
    const ids = instanceIds(scaled);
    const cancelledOnBoth = await observeEveryReplica(cancelled, ids, 'CANCELLED');
    const createdOnBoth = await observeEveryReplica(created, ids);
    const live = await createOrder(rider, 'xujiahui', 'shanghai-station');
    const liveOnBoth = await observeEveryReplica(live, ids);

    const samples = [];
    const distribution = Object.fromEntries(ids.map(id => [id, 0]));
    for (let index = 0; index < 12; index++) {
      const result = await detail(cancelled);
      assert.ok(reflects(result, cancelled.order, 'CANCELLED'), 'Scaled queries must all return the cancellation');
      assert.ok(ids.includes(result.instance), 'The response must identify a registered replica');
      distribution[result.instance]++;
      samples.push(observation(result));
    }
    assert.ok(Object.values(distribution).every(count => count > 0), 'Both replicas must serve requests');

    compose(adjust(1, '-d'));
    const after = await waitFor('one ready query replica after scaling down', () => readyReplicas(1));
    assert.deepEqual(containers().map(container => container.status), ['running']);
    restoreScale = false;
    const remaining = instanceIds(after);
    const verifiedAfter = [
      ...await observeEveryReplica(cancelled, remaining, 'CANCELLED'),
      ...await observeEveryReplica(created, remaining),
      ...await observeEveryReplica(live, remaining),
    ];
    const engine = JSON.parse(docker(['version', '--format', '{{json .Server}}']));
    report = {
      executed_at: new Date().toISOString(),
      platform: { docker_version: engine.Version, os: engine.Os, compose_version: compose(['version', '--short']) },
      service,
      before,
      during_scale_up: { containers: prepared, cancelled: originalDuringWrites[0], created_order_id: created.order.id },
      after_scale_up: {
        ...scaled, distribution, samples, cancelled_on_both: cancelledOnBoth,
        created_on_both: createdOnBoth, live_write_on_both: liveOnBoth,
      },
      after_scale_down: { ...after, verified_orders: verifiedAfter },
    };
  } finally {
    try {
      if (restoreScale) compose(adjust(1, '-d'));
    } finally {
      try {
        for (const entry of createdOrders) {
          const result = await cancel(entry);
          assert.ok(result.status === 200 || (result.status === 409 && result.data.error?.code === 'INVALID_STATE'),
            'Could not finish cleanup for demo order ' + entry.order.id);
        }
      } finally {
        if (!originalDriver.online) await setOnline(driver, false);
      }
    }
  }

  mkdirSync(evidenceDir, { recursive: true });
  const output = path.join(evidenceDir, 'scaling.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: 1 → 2 → 1 ready query replicas. Both replicas saw the new and cancelled orders. ' + output);
}

await run();
