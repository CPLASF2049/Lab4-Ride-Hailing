import { openDb } from '../../common/db.mjs';
import { config } from '../../common/config.mjs';
import { createServer, HttpError, log } from '../../common/http.mjs';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const live = new Map();

function validate(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'INVALID_INSTANCE', '实例信息必须是 JSON 对象');
  const service = String(body.service || '');
  if (!NAME.test(service)) throw new HttpError(400, 'INVALID_SERVICE', '服务名必须是小写字母、数字或连字符，长度 2–41');
  const address = String(body.address || '');
  if (!/^[A-Za-z0-9.:-]{1,80}$/.test(address)) throw new HttpError(400, 'INVALID_ADDRESS', '实例地址格式无效');
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'INVALID_PORT', '实例端口必须是 1–65535 的整数');
  const ttlMs = Number(body.ttl_ms ?? 10000);
  if (!Number.isInteger(ttlMs) || ttlMs < 2000 || ttlMs > 60000) throw new HttpError(400, 'INVALID_TTL', '租约 TTL 必须是 2000–60000 毫秒');
  return { service, address, port, ttl_ms: ttlMs };
}
const alive = instance => Date.now() - instance.last_seen <= instance.ttl_ms;
const publicView = instance => ({ id: instance.id, service: instance.service, address: instance.address, port: instance.port, last_seen: new Date(instance.last_seen).toISOString(), age_ms: Date.now() - instance.last_seen });

export function createRegistry(options = {}) {
  const cfg = { ...config('registry', 8500), ...options };
  const db = openDb(cfg.dbPath || ':memory:'); // keeps /health honest about process liveness only
  const server = createServer({ service: 'registry', routes: [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => {
      db.prepare('SELECT 1').get();
      const counts = {};
      for (const instance of live.values()) if (alive(instance)) counts[instance.service] = (counts[instance.service] || 0) + 1;
      return { status: 'ok', service: 'registry', instances: counts };
    } },
    { method: 'GET', path: '/v1/catalog/:service', role: 'PUBLIC', handler: c => {
      if (!NAME.test(c.params.service)) throw new HttpError(400, 'INVALID_SERVICE', '服务名格式无效');
      const instances = [...live.values()].filter(instance => instance.service === c.params.service && alive(instance))
        .sort((a, b) => a.id.localeCompare(b.id)).map(publicView);
      return { service: c.params.service, count: instances.length, generated_at: new Date().toISOString(), instances };
    } },
    { method: 'GET', path: '/v1/catalog', role: 'PUBLIC', handler: () => {
      const services = {};
      for (const instance of live.values()) {
        if (!alive(instance)) continue;
        (services[instance.service] ||= []).push(publicView(instance));
      }
      for (const list of Object.values(services)) list.sort((a, b) => a.id.localeCompare(b.id));
      return { generated_at: new Date().toISOString(), services };
    } },
    { method: 'PUT', path: '/v1/instances/:id', role: 'INTERNAL', handler: c => {
      const id = c.params.id;
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new HttpError(400, 'INVALID_INSTANCE_ID', '实例 ID 格式无效');
      const { service, address, port, ttl_ms: ttlMs } = validate(c.body);
      const existing = live.get(id);
      if (existing && (existing.service !== service || existing.address !== address || existing.port !== port)) {
        throw new HttpError(409, 'INSTANCE_CONFLICT', '实例 ID 已绑定到其他地址或服务');
      }
      const instance = { id, service, address, port, ttl_ms: ttlMs, registered_at: existing?.registered_at || Date.now(), last_seen: Date.now() };
      live.set(id, instance);
      if (!existing) log('registry', 'instance_registered', { instance_id: id, service, address, port });
      return { registered: true, instance: publicView(instance) };
    } },
    { method: 'DELETE', path: '/v1/instances/:id', role: 'INTERNAL', handler: c => {
      const existed = live.delete(c.params.id);
      if (existed) log('registry', 'instance_deregistered', { instance_id: c.params.id });
      return { deregistered: existed };
    } },
  ], });
  const sweeper = setInterval(() => {
    const removed = [];
    for (const [id, instance] of live) {
      if (!alive(instance)) { live.delete(id); removed.push(instance); }
    }
    if (removed.length) log('registry', 'expired', { instances: removed.map(i => i.id) });
  }, 1000);
  sweeper.unref();
  let closed = false;
  async function close() {
    if (closed) return; closed = true; clearInterval(sweeper);
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
  return { server, db, live, close };
}
