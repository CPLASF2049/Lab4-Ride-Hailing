import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createOrder } from '../services/order/service.mjs';
import { createQuery } from '../services/query/service.mjs';
import { createDriver } from '../services/driver/service.mjs';
import { createDispatch } from '../services/dispatch/service.mjs';
import { createPricing } from '../services/pricing/service.mjs';
import { createGateway } from '../services/gateway/service.mjs';
import { login } from '../common/auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(path.join(root, '.runtime', 'acceptance'), { recursive: true });
const data = mkdtempSync(path.join(root, '.runtime', 'acceptance', 'run-'));
const evidence = path.join(root, 'docs', 'evidence'); mkdirSync(evidence, { recursive: true });
const started = new Date(); const results = []; const services = new Map(); const urls = {};
let dropReserveReply = false; let reserveResponseDropped = false;
const tokens = Object.fromEntries(['rider-1','rider-2','driver-1','driver-2'].map(id => [id, login(id).token]));
const dbPath = name => path.join(data, `${name}.sqlite`);
async function bind(name, service, port = 0) {
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
  services.set(name, service); urls[`${name}Url`] = `http://127.0.0.1:${service.server.address().port}`; return service;
}
async function reservedPorts() {
  const servers = [http.createServer(), http.createServer()];
  await Promise.all(servers.map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  const ports = servers.map(s => s.address().port);
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); return ports;
}
async function api(route, { actor = 'rider-1', method = 'GET', body, key, internal = false, base = urls.gatewayUrl } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Authorization = `Bearer ${tokens[actor]}`;
  if (key) headers['Idempotency-Key'] = key;
  if (internal) headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  return { status: response.status, body: await response.json() };
}
async function ok(route, options) { const result = await api(route, options); assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result)); return result.body; }
async function step(name, operation) {
  const begin = Date.now();
  try { const details = await operation(); results.push({ name, status: 'PASS', duration_ms: Date.now() - begin, ...details }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'FAIL', message: error.message, duration_ms: Date.now() - begin }); throw error; }
}
async function pump(rounds = 2) {
  for (let i = 0; i < rounds; i++) { await services.get('order').tick(); await services.get('dispatch').tick(); }
  await services.get('order').tick();
}
async function online(id, value) { return (await ok('/api/drivers/me/status', { actor: id, method: 'PUT', body: { online: value } })).driver; }
async function create(rider = 'rider-1') {
  const { estimate } = await ok('/api/orders/estimate', { actor: rider, method: 'POST', body: { origin_id: 'fudan', destination_id: 'bund' } });
  const { order } = await ok('/api/orders', { actor: rider, method: 'POST', key: randomUUID(), body: { estimate_id: estimate.id } });
  return order;
}
async function offer(orderId, driver = 'driver-1') {
  const list = (await ok('/api/drivers/me/offers', { actor: driver })).offers;
  const result = list.find(o => o.order_id === orderId); assert.ok(result, `No offer for ${driver}: ${orderId}`); return result;
}
async function accept(orderId, driver = 'driver-1') {
  const item = await offer(orderId, driver);
  return { item, ...(await ok(`/api/offers/${item.id}/accept`, { actor: driver, method: 'POST' })) };
}
const act = (id, action, actor = 'driver-1', body) => ok(`/api/orders/${id}/${action}`, { actor, method: 'POST', body });
async function stop(name) { const service = services.get(name); if (service) { services.delete(name); await service.close(); } }
let orderOptions; let dispatchOptions; let queryOptions; let driverPort; let queryPort; let orderPort; let dispatchPort;
async function restartOrder() { await stop('order'); await bind('order', createOrder(orderOptions), orderPort); }
async function restartDriver() { await stop('driver'); await bind('driver', createDriver({ dbPath: dbPath('driver') }), driverPort); }
async function restartQuery() { await stop('query'); await bind('query', createQuery(queryOptions), queryPort); }
async function restartDispatch() { await stop('dispatch'); await bind('dispatch', createDispatch(dispatchOptions), dispatchPort); }

try {
  await bind('driver', createDriver({ dbPath: dbPath('driver') })); driverPort = services.get('driver').server.address().port;
  await bind('pricing', createPricing({ dbPath: dbPath('pricing') }));
  queryOptions = { dbPath: dbPath('query'), driverUrl: urls.driverUrl };
  await bind('query', createQuery(queryOptions)); queryPort = services.get('query').server.address().port;
  // A test-only HTTP fault proxy can lose a reply after Driver has committed.
  const proxy = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const upstream = await fetch(urls.driverUrl + req.url, { method: req.method, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.INTERNAL_TOKEN || 'lab3-local-internal' }, body: ['GET','HEAD'].includes(req.method) ? undefined : raw, signal: AbortSignal.timeout(2000) });
      const payload = await upstream.text();
      if (dropReserveReply && req.url.endsWith('/reserve') && upstream.ok) { dropReserveReply = false; reserveResponseDropped = true; res.destroy(); return; }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(payload);
    } catch { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'DRIVER_UNAVAILABLE', message: 'test driver stopped' } })); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  services.set('fault-proxy', { server: proxy, close: () => new Promise(resolve => proxy.close(resolve)) });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  [orderPort, dispatchPort] = await reservedPorts();
  urls.orderUrl = `http://127.0.0.1:${orderPort}`; urls.dispatchUrl = `http://127.0.0.1:${dispatchPort}`;
  orderOptions = { dbPath: dbPath('order'), ...urls, driverUrl: proxyUrl };
  dispatchOptions = { dbPath: dbPath('dispatch'), ...urls, offerTtlMs: 800, dispatchWaitMs: 5000 };
  await bind('order', createOrder(orderOptions), orderPort);
  await bind('dispatch', createDispatch(dispatchOptions), dispatchPort);
  await bind('gateway', createGateway(urls));

  await step('五个业务服务健康、预设身份和网关隔离', async () => {
    const healthy = await ok('/api/system/health'); assert.equal(Object.keys(healthy.services).length, 5);
    assert.ok(Object.values(healthy.services).every(s => s.healthy));
    const accounts = await ok('/api/auth/accounts'); assert.equal(accounts.accounts.length, 4);
    const signed = await ok('/api/auth/login', { method: 'POST', body: { account_id: 'rider-1' } }); assert.ok(signed.token);
    assert.equal((await api('/api/internal/diagnostics')).status, 404);
    const page = await fetch(urls.gatewayUrl); assert.ok(page.ok); assert.ok((await page.text()).includes('沪行'));
    assert.ok((await fetch(urls.gatewayUrl + '/vendor/leaflet/leaflet.js')).ok);
    return { business_services: 5, transport: 'real HTTP', databases: 'five isolated SQLite files' };
  });
  await step('完整主流程、忙时下线、费用与历史查询', async () => {
    await online('driver-1', true); const order = await create(); await pump();
    const accepted = await accept(order.id); assert.equal(accepted.order.status, 'ACCEPTED'); await pump();
    const combined = await ok(`/api/orders/${order.id}`); assert.equal(combined.driver.name, '王师傅');
    const offline = await online('driver-1', false); assert.equal(offline.active_order_id, order.id);
    await act(order.id, 'arrive'); const start = await act(order.id, 'start'); const repeat = await act(order.id, 'start');
    assert.equal(start.order.started_at, repeat.order.started_at);
    assert.equal((await api(`/api/orders/${order.id}/cancel`, { method: 'POST' })).status, 409);
    const final = await act(order.id, 'finish', 'driver-1', { distance_m: 9000 });
    assert.equal(final.order.final_amount_cents, 2700);
    assert.deepEqual((await act(order.id, 'finish', 'driver-1', { distance_m: 1 })).order, final.order);
    await pump(); const driver = (await ok('/api/drivers/me', { actor: 'driver-1' })).driver;
    assert.equal(driver.online, false); assert.equal(driver.active_order_id, null);
    assert.ok((await ok('/api/orders/history')).orders.some(o => o.id === order.id && o.status === 'COMPLETED'));
    return { order_id: order.id, final_amount_cents: 2700 };
  });
  await step('已到达后取消、重新叫车、旧接单与旧释放均无害', async () => {
    await online('driver-1', true); await online('driver-2', true);
    const old = await create(); await pump(); const first = await accept(old.id); await act(old.id, 'arrive');
    await act(old.id, 'cancel', 'rider-1'); await pump();
    const next = await create(); assert.notEqual(next.id, old.id); await pump(); const second = await accept(next.id); await pump();
    assert.equal((await api(`/api/offers/${first.item.id}/accept`, { actor: 'driver-1', method: 'POST' })).status, 409);
    await ok(`/internal/drivers/driver-1/release`, { base: urls.driverUrl, internal: true, method: 'POST', body: { order_id: old.id, assignment_id: first.order.assignment_id } });
    assert.equal((await ok('/api/drivers/me', { actor: 'driver-1' })).driver.active_order_id, next.id);
    assert.equal(second.order.status, 'ACCEPTED'); await act(next.id, 'cancel', 'rider-1'); await pump();
    return { cancelled_order_id: old.id, rebooked_order_id: next.id };
  });
  await step('拒单顺序重派且全部拒绝后有明确失败结果', async () => {
    const order = await create(); await pump(); const first = await offer(order.id);
    await ok(`/api/offers/${first.id}/reject`, { actor: 'driver-1', method: 'POST' }); await pump(); const second = await offer(order.id, 'driver-2');
    await ok(`/api/offers/${second.id}/reject`, { actor: 'driver-2', method: 'POST' }); await pump();
    assert.equal((await ok(`/api/orders/${order.id}`)).order.status, 'FAILED');
    return { order_id: order.id, tried_drivers: 2 };
  });
  await step('派单等待中重启、超时重派及迟到接单被拒绝', async () => {
    const order = await create(); await pump(); const first = await offer(order.id);
    await stop('dispatch'); await delay(850); await restartDispatch(); await pump();
    assert.equal((await api(`/api/offers/${first.id}/accept`, { actor: 'driver-1', method: 'POST' })).status, 409);
    await offer(order.id, 'driver-2'); await delay(850); await pump();
    assert.equal((await ok(`/api/orders/${order.id}`)).order.status, 'FAILED'); return { order_id: order.id };
  });
  await step('无人可用立即终止，不无限等待', async () => {
    await online('driver-1', false); await online('driver-2', false); const order = await create(); await pump();
    const state = (await ok(`/api/orders/${order.id}`)).order; assert.equal(state.status, 'FAILED'); assert.equal(state.failure_reason, 'NO_DRIVER');
    return { order_id: order.id };
  });
  await step('两个订单竞争同一司机，只有一份有效占用', async () => {
    await online('driver-1', true);
    const [one, two] = await Promise.all([create('rider-1'), create('rider-2')]); await pump();
    const [a, b] = await Promise.all([accept(one.id), accept(two.id)]);
    assert.equal([a.order, b.order].filter(o => o.status === 'ACCEPTED').length, 1);
    await pump(); const d = (await ok('/api/drivers/me', { actor: 'driver-1' })).driver;
    const winner = a.order.status === 'ACCEPTED' ? one : two; assert.equal(d.active_order_id, winner.id);
    assert.equal((await api(`/api/orders/${winner.id}`, { actor: winner.rider_id === 'rider-1' ? 'rider-2' : 'rider-1' })).status, 403);
    await act(winner.id, 'cancel', winner.rider_id); await pump();
    return { winning_order_id: winner.id, competing_order_ids: [one.id, two.id] };
  });
  await step('派单后司机下线，在最终占用时拒绝接单', async () => {
    const order = await create(); await pump(); await online('driver-1', false);
    const result = await accept(order.id); assert.equal(result.order.status, 'MATCHING'); assert.equal(result.order.last_assignment_failure, 'DRIVER_OFFLINE');
    await pump(); assert.equal((await ok(`/api/orders/${order.id}`)).order.status, 'FAILED');
    assert.equal((await ok('/api/drivers/me', { actor: 'driver-1' })).driver.active_order_id, null); return { order_id: order.id };
  });
  await step('司机占用已提交但HTTP响应丢失，重启订单服务后幂等恢复', async () => {
    await online('driver-1', true); const order = await create(); await pump(); dropReserveReply = true;
    const result = await accept(order.id); assert.equal(result.order.status, 'ASSIGNING'); assert.equal(reserveResponseDropped, true);
    assert.equal((await ok('/api/drivers/me', { actor: 'driver-1' })).driver.active_order_id, order.id);
    await restartOrder(); await delay(300); await pump();
    assert.equal((await ok(`/api/orders/${order.id}`)).order.status, 'ACCEPTED');
    await act(order.id, 'cancel', 'rider-1'); await pump(); return { order_id: order.id, dropped_reply_after_commit: true };
  });
  await step('查询服务停机期间写入、Outbox持久化与重启后自动补投', async () => {
    const order = await create(); await pump(); await accept(order.id); await pump();
    await stop('query'); await act(order.id, 'arrive'); const startedOrder = (await act(order.id, 'start')).order; await services.get('order').tick();
    const diagnostics = await ok('/internal/diagnostics', { base: urls.orderUrl, internal: true });
    assert.ok(diagnostics.pending_events.some(e => e.destination === 'query'));
    await restartOrder(); await restartQuery();
    const lag = await api(`/api/orders/${order.id}?min_version=${startedOrder.version}`); assert.equal(lag.status, 202); assert.equal(lag.body.sync_pending, true);
    await delay(300); await pump(); assert.equal((await ok(`/api/orders/${order.id}`)).order.status, 'IN_PROGRESS');
    return { order_id: order.id, retained_pending_events: diagnostics.pending_events.length };
  });
  await step('组合查询依赖降级、完成后待释放任务跨服务重启恢复', async () => {
    const current = await ok('/api/orders/current'); assert.equal(current.order.status, 'IN_PROGRESS'); const id = current.order.id;
    await stop('driver'); const partial = await ok(`/api/orders/${id}`); assert.equal(partial.partial, true); assert.equal(partial.driver, null);
    const final = (await act(id, 'finish', 'driver-1', { distance_m: 9000 })).order; assert.equal(final.status, 'COMPLETED');
    await services.get('order').tick();
    const diagnostic = await ok('/internal/diagnostics', { base: urls.orderUrl, internal: true }); assert.ok(diagnostic.pending_jobs.some(j => j.type === 'RELEASE_DRIVER'));
    await restartOrder(); await restartDriver(); await delay(300); await pump();
    assert.equal((await ok('/api/drivers/me', { actor: 'driver-1' })).driver.active_order_id, null);
    assert.equal((await ok(`/api/orders/${id}`)).order.status, 'COMPLETED');
    return { order_id: id, recovered_release: true };
  });
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  for (const name of ['gateway','order','dispatch','query','pricing','fault-proxy','driver']) {
    try { await stop(name); } catch (error) { console.error(`closing ${name}: ${error.message}`); process.exitCode = 1; }
  }
  const summary = { started_at: started.toISOString(), finished_at: new Date().toISOString(), node: process.version, environment: 'Node factories bound to independent HTTP ports and isolated persistent databases; real service RPC; fault injection exists only in this runner', timings: { offer_ttl_ms: 800, overall_wait_ms: 5000 }, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results };
  writeFileSync(path.join(evidence, 'acceptance.json'), JSON.stringify(summary, null, 2));
  console.log(`Acceptance: ${summary.passed}/${results.length} passed. Evidence: docs/evidence/acceptance.json`);
}
