import { randomUUID } from 'node:crypto';

const base = process.env.GATEWAY_URL || 'http://127.0.0.1:8083';
const accounts = {
  rider: 'rider-1', rider2: 'rider-2', driver: 'driver-1', driver2: 'driver-2',
};
async function api(path, { method = 'GET', token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: response.status, data, instance: response.headers.get('x-instance') };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000, interval = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(interval); }
  return null;
}

const tokens = {};
for (const [role, id] of Object.entries(accounts)) {
  const result = await api('/api/auth/login', { method: 'POST', body: { account_id: id } });
  if (result.status !== 200) throw new Error(`login ${id}: ${result.status}`);
  tokens[role] = result.data.token;
}
await api('/api/drivers/me/status', { method: 'PUT', token: tokens.driver, body: { online: true } });
const estimate = await api('/api/orders/estimate', { method: 'POST', token: tokens.rider, body: { origin_id: 'fudan', destination_id: 'bund' } });
if (estimate.status !== 200) throw new Error(`estimate ${JSON.stringify(estimate.data)}`);
const created = await api('/api/orders', { method: 'POST', token: tokens.rider, key: randomUUID(), body: { estimate_id: estimate.data.estimate.id } });
if (created.status !== 201) throw new Error(`create ${JSON.stringify(created.data)}`);
const orderId = created.data.order.id;
const offer = await until(async () => {
  const list = await api('/api/drivers/me/offers', { token: tokens.driver });
  return list.data.offers?.find(item => item.order_id === orderId);
});
if (!offer) throw new Error('no offer received');
const accepted = await api(`/api/offers/${offer.id}/accept`, { method: 'POST', token: tokens.driver });
const acceptedVersion = accepted.data.order?.version || 1;
const detail = await until(async () => {
  const result = await api(`/api/orders/${orderId}?min_version=${acceptedVersion}`, { token: tokens.rider });
  return result.status === 200 && result.data.order.status === 'ACCEPTED' ? result : null;
});
if (!detail) throw new Error('query did not catch up to accepted version');
await api(`/api/orders/${orderId}/cancel`, { method: 'POST', token: tokens.rider });
console.log(JSON.stringify({
  order_id: orderId,
  create_instance: created.instance,
  detail_instance: detail.instance,
  status_after_accept: accepted.data.order?.status,
  detail_status: detail.data.order.status,
  driver_from_combination: detail.data.driver?.name,
  query_partial: detail.data.partial,
  registry: (await api('/api/system/discovery')).data,
}, null, 2));
