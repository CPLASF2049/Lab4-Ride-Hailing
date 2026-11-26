import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:8083';
const compose = args => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, { method = 'GET', token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: response.status, data, instance: response.headers.get('x-instance') || null };
}
async function until(check, timeout = 45000, interval = 400) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(interval); }
  return null;
}
const cluster = async () => (await api('/api/system/health')).data.services['order-query'];

const login = (await api('/api/auth/login', { method: 'POST', body: { account_id: 'rider-1' } })).data;
const token = login.token;
let history = (await api('/api/orders/history', { token })).data.orders || [];
if (!history.length) {
  const estimate = (await api('/api/orders/estimate', { method: 'POST', token, body: { origin_id: 'fudan', destination_id: 'bund' } })).data.estimate;
  await api('/api/orders', { method: 'POST', token, key: randomUUID(), body: { estimate_id: estimate.id } });
  history = [{ id: (await until(async () => (await api('/api/orders/current', { token })).data.order, 8000))?.id }];
}
const orderId = history[0].id;

const before = await cluster();
const beforeInstances = before.instances;

execFileSync('docker', ['compose', 'up', '-d', '--scale', 'order-query=2', '--no-recreate'], { cwd: root, stdio: 'inherit' });
const scaled = await until(async () => {
  const state = await cluster();
  const ready = state.instances === 2 && state.checks.every(check => check.healthy && (!check.bootstrap_state || check.bootstrap_state === 'READY'));
  return ready ? state : null;
});
if (!scaled) throw new Error('order-query replicas did not become ready');

const samples = [];
for (let i = 0; i < 12; i++) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await api(`/api/orders/${orderId}`, { token });
    if (result.status === 200) break;
    await sleep(500);
  }
  samples.push({ status: result.status, instance: result.instance, has_driver: Boolean(result.data?.driver), partial: result.data?.partial });
  await sleep(250);
}
const distribution = samples.reduce((acc, item) => { if (item.status === 200) acc[item.instance] = (acc[item.instance] || 0) + 1; return acc; }, {});
const replicatedOrderOk = samples.filter(item => item.status === 200 && item.instance).length === samples.length;
if (!(Object.keys(distribution).length >= 2)) throw new Error(`traffic not balanced across replicas: ${JSON.stringify(distribution)}`);

const psScaled = compose(['ps', '--format', 'json']);
execFileSync('docker', ['compose', 'up', '-d', '--scale', 'order-query=1', '--no-recreate'], { cwd: root, stdio: 'inherit' });
const after = await until(async () => { const state = await cluster(); return state.instances === 1 ? state : null; });
if (!after) throw new Error('order-query did not scale back to one instance');
const afterInstance = (await api(`/api/orders/${orderId}`, { token })).instance;

const report = {
  executed_at: new Date().toISOString(),
  platform: 'Docker Compose (Docker Desktop, Linux containers)',
  service: 'order-query',
  order_id: orderId,
  before: { instances: beforeInstances, checks: before.checks },
  after_scale_up: { instances: scaled.instances, checks: scaled.checks, distribution, samples, ordered_ok: replicatedOrderOk },
  after_scale_down: { instances: after.instances, checks: after.checks, remaining_instance: afterInstance },
  commands: {
    scale_up: 'docker compose up -d --scale order-query=2 --no-recreate',
    scale_down: 'docker compose up -d --scale order-query=1 --no-recreate',
  },
  compose_ps: psScaled,
};
mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'evidence', 'scaling.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
