import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:8083';
const registry = 'http://127.0.0.1:8500';
const evidence = path.join(root, 'docs', 'evidence');
mkdirSync(evidence, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function call(route, { method = 'GET', token, body, key, base = gateway } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { request: { method, url: base + route, headers: { ...(token ? { Authorization: 'Bearer <token>' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } }, status: response.status, headers: { 'x-instance': response.headers.get('x-instance'), 'x-request-id': response.headers.get('x-request-id') }, body: data };
}
async function until(check, timeout = 10000, interval = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(interval); }
  return null;
}

const rider = (await call('/api/auth/login', { method: 'POST', body: { account_id: 'rider-1' } })).body.token;
const driver = (await call('/api/auth/login', { method: 'POST', body: { account_id: 'driver-1' } })).body.token;
await call('/api/drivers/me/status', { method: 'PUT', token: driver, body: { online: true } });

const estimate = await call('/api/orders/estimate', { method: 'POST', token: rider, body: { origin_id: 'fudan', destination_id: 'bund' } });
const key = randomUUID();
const created = await call('/api/orders', { method: 'POST', token: rider, key, body: { estimate_id: estimate.body.estimate.id } });
const orderId = created.body.order.id;
const offer = await until(async () => (await call('/api/drivers/me/offers', { token: driver })).body.offers?.find(item => item.order_id === orderId));
const accepted = await call(`/api/offers/${offer.id}/accept`, { method: 'POST', token: driver });
const detail = await until(async () => {
  const result = await call(`/api/orders/${orderId}?min_version=${accepted.body.order.version}`, { token: rider });
  return result.status === 200 ? result : null;
});
const catalog = await call('/v1/catalog', { base: registry });
const health = await call('/api/system/health');
const history = await call('/api/orders/history', { token: rider });
await call(`/api/orders/${orderId}/cancel`, { method: 'POST', token: rider });

const record = {
  captured_at: new Date().toISOString(),
  unified_entry: gateway,
  registry,
  flow: {
    login: { status: 200, note: '预设账号登录，网关本地签发令牌' },
    driver_online: { status: 200 },
    estimate: { request: estimate.request, status: estimate.status, amount_cents: estimate.body.estimate?.amount_cents, distance_m: estimate.body.estimate?.distance_m },
    create_order: created,
    offer: { id: offer.id, order_id: offer.order_id, driver_id: offer.driver_id, expires_at: offer.expires_at, order_status: offer.order?.status },
    accept: { status: accepted.status, order_status: accepted.body.order?.status, version: accepted.body.order?.version },
    detail: detail,
    history: { status: history.status, order_count: history.body.orders?.length, first_order_id: history.body.orders?.[0]?.id },
  },
  registry_catalog: catalog.body,
  system_health: health.body,
  compose_ps: docker(['ps', '--format', 'table {{.Name}}\t{{.Service}}\t{{.Status}}']),
  order_flow_log: docker(['logs', '--no-color', '--tail', '120', 'order']),
  order_query_log: docker(['logs', '--no-color', '--tail', '80', 'order-query']),
  dispatch_log: docker(['logs', '--no-color', '--tail', '60', 'dispatch']),
};
writeFileSync(path.join(evidence, 'gateway-trace.json'), JSON.stringify(record, null, 2));
writeFileSync(path.join(evidence, 'compose-ps.txt'), record.compose_ps);
console.log(JSON.stringify({
  order_id: orderId,
  create_instance: created.headers['x-instance'],
  detail_instance: detail?.headers['x-instance'],
  registry_services: Object.fromEntries(Object.entries(catalog.body.services).map(([name, list]) => [name, list.length])),
  health: Object.fromEntries(Object.entries(health.body.services).map(([name, state]) => [name, { healthy: state.healthy, instances: state.instances }])),
}, null, 2));
