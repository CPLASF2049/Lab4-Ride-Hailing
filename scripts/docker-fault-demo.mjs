import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:8083';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function api(route, { method = 'GET', token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const started = Date.now();
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: response.status, data, elapsed_ms: Date.now() - started, instance: response.headers.get('x-instance') };
}
async function until(check, timeout = 20000, interval = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(interval); }
  return null;
}
function resilience() {
  const output = docker(['exec', '-T', 'order-query', 'node', '-e', "fetch('http://127.0.0.1:3102/internal/resilience',{headers:{'X-Internal-Token':'lab3-local-internal'}}).then(r=>r.text()).then(t=>process.stdout.write(t))"]);
  return JSON.parse(output);
}

const rider = (await api('/api/auth/login', { method: 'POST', body: { account_id: 'rider-1' } })).data.token;
const driver = (await api('/api/auth/login', { method: 'POST', body: { account_id: 'driver-1' } })).data.token;
await api('/api/drivers/me/status', { method: 'PUT', token: driver, body: { online: true } });
let current = (await api('/api/orders/current', { token: rider })).data.order;
if (current) await api(`/api/orders/${current.id}/cancel`, { method: 'POST', token: rider });

const estimate = (await api('/api/orders/estimate', { method: 'POST', token: rider, body: { origin_id: 'fudan', destination_id: 'bund' } })).data.estimate;
const created = await api('/api/orders', { method: 'POST', token: rider, key: randomUUID(), body: { estimate_id: estimate.id } });
if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.data)}`);
const orderId = created.data.order.id;
const offer = await until(async () => (await api('/api/drivers/me/offers', { token: driver })).data.offers?.find(item => item.order_id === orderId));
if (!offer) throw new Error('no offer');
const accepted = await api(`/api/offers/${offer.id}/accept`, { method: 'POST', token: driver });
if (accepted.status !== 200) throw new Error(`accept: ${JSON.stringify(accepted.data)}`);
await until(async () => { const result = await api(`/api/orders/${orderId}`, { token: rider }); return result.status === 200 && result.data.order.status === 'ACCEPTED'; });

const healthy = await api(`/api/orders/${orderId}`, { token: rider });
const before = resilience();

docker(['stop', 'driver']);
const degraded = [];
for (let i = 0; i < 6; i++) {
  const result = await api(`/api/orders/${orderId}`, { token: rider });
  degraded.push({
    status: result.status, partial: result.data.partial, warning: result.data.warnings?.[0]?.code,
    elapsed_ms: result.elapsed_ms, circuit: result.data.degradation?.circuit,
  });
  await sleep(250);
}
const open = resilience();
const openRequest = await api(`/api/orders/${orderId}`, { token: rider });

docker(['start', 'driver']);
await until(async () => {
  const health = (await api('/api/system/health')).data.services.driver;
  return health.instances === 1 && health.healthy;
}, 30000);
await sleep(9000);
const recovered = await api(`/api/orders/${orderId}`, { token: rider });
const closed = resilience();
await api(`/api/orders/${orderId}/cancel`, { method: 'POST', token: rider });

const report = {
  executed_at: new Date().toISOString(),
  platform: 'Docker Compose',
  order_id: orderId,
  api: 'GET /api/orders/:id',
  dependency: 'driver-service',
  phases: {
    healthy: { status: healthy.status, partial: healthy.data.partial, driver: healthy.data.driver?.name, elapsed_ms: healthy.elapsed_ms, circuit: before.circuit.state },
    driver_stopped: { requests: degraded, circuit_after: open.circuit, rate_limit_after: open.rate_limit },
    circuit_open_short_circuit: { status: openRequest.status, warning: openRequest.data.warnings?.[0]?.code, elapsed_ms: openRequest.elapsed_ms, partial: openRequest.data.partial },
    recovered: { status: recovered.status, partial: recovered.data.partial, driver: recovered.data.driver?.name, circuit: closed.circuit, driver_stats: closed.driver },
  },
  commands: { stop: 'docker compose stop driver', start: 'docker compose start driver' },
};
mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'evidence', 'fault-tolerance-docker.json'), JSON.stringify(report, null, 2));
writeFileSync(path.join(root, 'docs', 'evidence', 'order-query.log'), docker(['logs', '--no-color', '--tail', '80', 'order-query']));
console.log(JSON.stringify(report, null, 2));
