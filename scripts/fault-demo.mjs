import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createQuery } from '../services/query/service.mjs';
import { CircuitBreaker, RateLimiter } from '../common/resilience.mjs';
import { login } from '../common/auth.mjs';
import { Order } from '../services/order/domain/order.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
const data = mkdtempSync(path.join(root, '.runtime', 'fault-'));
const tokens = { rider1: login('rider-1').token, rider2: login('rider-2').token };
const profile = { id: 'driver-1', name: '王师傅', phone_mask: '138****1001', vehicle: { plate: '沪A·L3101', model: '大众朗逸', color: '白色' }, online: true, active_order_id: null, active_assignment_id: null, updated_at: new Date().toISOString() };

const control = { mode: 'ok', delayMs: 0 };
let driverCalls = 0;
const stub = http.createServer(async (req, res) => {
  if (req.url.startsWith('/control')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    Object.assign(control, JSON.parse(raw || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(control));
  }
  if (req.url.startsWith('/internal/drivers/')) {
    driverCalls++;
    if (control.mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'DRIVER_INTERNAL', message: '模拟持续失败' } })); }
    await delay(control.delayMs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ driver: { ...profile, updated_at: new Date().toISOString() } }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

function seedOrder(service, id, rider, status) {
  const order = Order.create({
    id, riderId: rider, at: new Date(Date.now() - 60000).toISOString(),
    estimate: { id: `estimate-${id}`, rider_id: rider, distance_m: 8000, amount_cents: 2400, expires_at: new Date(Date.now() + 300000).toISOString(), origin: { id: 'fudan', name: '复旦', lat: 31.29, lng: 121.50 }, destination: { id: 'bund', name: '外滩', lat: 31.24, lng: 121.49 } },
  });
  if (status === 'ACCEPTED') { order.beginAssignment('driver-1', `offer-${id}`, `asg-${id}`, new Date().toISOString()); order.confirmAssignment(`asg-${id}`, new Date().toISOString()); }
  service.project({ event_id: `seed-${id}`, event_type: 'order.changed.v1', aggregate_id: id, version: order.data.version, occurred_at: order.data.updated_at, data: order.data });
  return order.data;
}

async function call(base, route, token, options = {}) {
  const started = Date.now();
  const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), ...options });
  const body = await response.json();
  return { status: response.status, body, headers: Object.fromEntries(response.headers), elapsed_ms: Date.now() - started };
}

async function run() {
  const breaker = new CircuitBreaker({ failureThreshold: 3, windowMs: 10000, openMs: 1200, name: 'driver-profile' });
  const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 100 });
  const app = createQuery({ dbPath: path.join(data, 'query.sqlite'), driverUrl: stubUrl, driverTimeoutMs: 250, driverAttempts: 2, breaker, limiter });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const order = seedOrder(app, 'order-fault', 'rider-1', 'ACCEPTED');
  const results = {};

  // 1. healthy dependency
  const normal = await call(base, `/orders/${order.id}`, tokens.rider1);
  results.normal = { status: normal.status, partial: normal.body.partial, driver: normal.body.driver?.name, elapsed_ms: normal.elapsed_ms, driver_calls: driverCalls };

  // 2. slow dependency: per-attempt timeout, bounded retry, fallback
  await fetch(`${stubUrl}/control`, { method: 'POST', body: JSON.stringify({ mode: 'slow', delayMs: 900 }) });
  const slow = await call(base, `/orders/${order.id}`, tokens.rider1);
  results.timeout = {
    status: slow.status, partial: slow.body.partial, warning: slow.body.warnings?.[0]?.code,
    elapsed_ms: slow.elapsed_ms, attempts: slow.body.degradation?.attempts, timeout_ms: 250,
    driver_calls: driverCalls,
  };

  // 3. persistent failure opens the breaker; an open breaker short-circuits without calling the dependency
  await fetch(`${stubUrl}/control`, { method: 'POST', body: JSON.stringify({ mode: 'fail', delayMs: 0 }) });
  const failures = [];
  for (let i = 0; i < 3; i++) { const r = await call(base, `/orders/${order.id}`, tokens.rider1); failures.push({ status: r.status, warning: r.body.warnings?.[0]?.code, circuit: r.body.degradation?.circuit }); }
  const callsBeforeOpen = driverCalls;
  const open = await call(base, `/orders/${order.id}`, tokens.rider1);
  results.breaker = {
    failures, open_state: breaker.snapshot().state,
    rejected_request: { status: open.status, warning: open.body.warnings?.[0]?.code, elapsed_ms: open.elapsed_ms },
    driver_calls_before_open: callsBeforeOpen, driver_calls_after_open: driverCalls,
    counters: breaker.snapshot().counters,
  };

  // 4. wait past openMs, dependency recovers -> half-open probe closes the breaker
  await fetch(`${stubUrl}/control`, { method: 'POST', body: JSON.stringify({ mode: 'ok', delayMs: 0 }) });
  await delay(1400);
  const recovered = await call(base, `/orders/${order.id}`, tokens.rider1);
  results.recovery = {
    status: recovered.status, partial: recovered.body.partial, driver: recovered.body.driver?.name,
    circuit: breaker.snapshot().state, open_ms: 1200, counters: breaker.snapshot().counters,
  };

  // 5. per-actor rate limit on a fresh app with a small bucket
  const limited = createQuery({ dbPath: path.join(data, 'query-limited.sqlite'), driverUrl: stubUrl, driverTimeoutMs: 250, driverAttempts: 1, rateCapacity: 3, rateRefill: 1, limiter: new RateLimiter({ capacity: 3, refillPerSecond: 1 }) });
  await new Promise(resolve => limited.server.listen(0, '127.0.0.1', resolve));
  const limitedBase = `http://127.0.0.1:${limited.server.address().port}`;
  seedOrder(limited, 'order-limited', 'rider-2', 'ACCEPTED');
  const rapid = [];
  for (let i = 0; i < 6; i++) { const r = await call(limitedBase, '/orders/order-limited', tokens.rider2); rapid.push({ status: r.status, retry_after: r.headers['retry-after'] || null }); }
  await delay(1100);
  const afterWait = await call(limitedBase, '/orders/order-limited', tokens.rider2);
  results.rate_limit = { capacity: 3, refill_per_second: 1, rapid, after_wait: { status: afterWait.status, retry_after: afterWait.headers['retry-after'] || null } };

  await app.close(); await limited.close();
  return results;
}

let results;
try { results = await run(); }
finally { stub.close(); }
const summary = {
  executed_at: new Date().toISOString(),
  api: 'GET /api/orders/:id（order-query 组合查询，依赖 driver-service 资料接口）',
  parameters: { driver_timeout_ms: 250, max_attempts: 2, retry_backoff_ms: 100, circuit_failure_threshold: 3, circuit_window_ms: 10000, circuit_open_ms: 1200, rate_capacity: 3, rate_refill_per_second: 1 },
  results,
};
writeFileSync(path.join(root, 'docs', 'evidence', 'fault-tolerance.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
