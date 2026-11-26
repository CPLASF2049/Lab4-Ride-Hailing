import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login } from '../common/auth.mjs';

const testRoot = path.resolve(fileURLToPath(new URL('../.runtime/tests/', import.meta.url)));
export function testDirectory(t) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'case-'));
  // Retain isolated test files under ignored .runtime for inspecting failed assertions.
  return directory;
}
export async function listen(service) {
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${service.server.address().port}`;
}
export async function request(base, route, { method = 'GET', body, actor = 'rider-1', internal = false, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Authorization = `Bearer ${login(actor).token}`;
  if (internal) headers['X-Internal-Token'] = process.env.INTERNAL_TOKEN || 'lab3-local-internal';
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() };
}
export function sampleEstimate(rider = 'rider-1') {
  return { id: `estimate-${rider}`, rider_id: rider, origin: { id: 'fudan', name: '复旦邯郸', lat: 31.2989, lng: 121.5033 }, destination: { id: 'bund', name: '外滩', lat: 31.24, lng: 121.49 }, distance_m: 8800, duration_s: 1200, amount_cents: 2650, expires_at: new Date(Date.now() + 300000).toISOString(), rule: { base_cents: 1200, per_km_cents: 250, included_m: 3000 } };
}
