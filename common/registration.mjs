import os from 'node:os';
import { log } from './log.mjs';

export function localAddress() {
  if (process.env.INSTANCE_ADDRESS) return process.env.INSTANCE_ADDRESS;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Announces one process instance in the registry and refreshes its lease.
 * A stopped process deregisters immediately; a crashed one expires by TTL.
 */
export async function registerInstance({
  registryUrl = process.env.REGISTRY_URL || '', service, port,
  address = localAddress(), ttlMs = 10000, heartbeatMs = 3000,
  internalToken = process.env.INTERNAL_TOKEN || 'lab3-local-internal',
  id: requestedId,
}) {
  const id = requestedId || `${service}-${os.hostname()}-${port}`;
  if (!process.env.INSTANCE_ID) process.env.INSTANCE_ID = id;
  if (!registryUrl) {
    log(service, 'registration_skipped', { instance_id: id, reason: 'REGISTRY_URL 未配置' });
    return { id, registered: false, stop: async () => {} };
  }
  const url = `${registryUrl.replace(/\/$/, '')}/v1/instances/${encodeURIComponent(id)}`;
  const body = JSON.stringify({ service, address, port, ttl_ms: ttlMs });
  let active = true;
  let failures = 0;
  async function announce() {
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken }, body, signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (failures) log(service, 'registration_recovered', { instance_id: id, service, address, port });
      failures = 0;
    } catch (error) {
      failures++;
      if (failures === 1) log(service, 'registration_retry', { instance_id: id, service, message: error.message });
    }
  }
  await announce();
  const timer = setInterval(() => { if (active) void announce(); }, heartbeatMs);
  timer.unref();
  log(service, 'registered', { instance_id: id, service, address, port, ttl_ms: ttlMs });
  return {
    id, address, port, registered: true,
    async stop() {
      if (!active) return;
      active = false; clearInterval(timer);
      try {
        await fetch(url, { method: 'DELETE', headers: { 'X-Internal-Token': internalToken }, signal: AbortSignal.timeout(800) });
        log(service, 'deregistered', { instance_id: id, service });
      } catch { /* TTL removes a failed deregistration. */ }
    },
  };
}
