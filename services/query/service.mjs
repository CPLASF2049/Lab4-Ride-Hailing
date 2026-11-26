import { openDb, migrate, transaction, now } from '../../common/db.mjs';
import { config } from '../../common/config.mjs';
import { createServer, HttpError, response, log } from '../../common/http.mjs';
import { Discovery } from '../../common/discovery.mjs';
import { CircuitBreaker, RateLimiter, withRetry } from '../../common/resilience.mjs';

const activeSql = "('MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS')";
const states = ['MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS','COMPLETED','CANCELLED','FAILED'];

export function createQuery(options = {}) {
  const cfg = { ...config('query', 3102), ...options };
  const db = openDb(cfg.dbPath);
  migrate(db, `
    CREATE TABLE IF NOT EXISTS order_views (
      id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, driver_id TEXT, status TEXT NOT NULL,
      version INTEGER NOT NULL, snapshot TEXT NOT NULL, projected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rider_history ON order_views(rider_id);
    CREATE INDEX IF NOT EXISTS driver_current ON order_views(driver_id,status);
    CREATE TABLE IF NOT EXISTS inbox (
      event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, version INTEGER NOT NULL, processed_at TEXT NOT NULL
    );
  `);
  const discovery = options.discovery || new Discovery({
    registryUrl: cfg.registryUrl,
    staticUrls: { driver: cfg.driverUrl, order: cfg.orderUrl, 'order-query': cfg.queryUrl },
  });
  const driverTimeoutMs = Number(options.driverTimeoutMs || process.env.DRIVER_TIMEOUT_MS || 600);
  const driverAttempts = Number(options.driverAttempts || process.env.DRIVER_ATTEMPTS || 2);
  const breaker = options.breaker || new CircuitBreaker({
    failureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD || 5),
    windowMs: Number(process.env.CIRCUIT_WINDOW_MS || 10000),
    openMs: Number(process.env.CIRCUIT_OPEN_MS || 8000),
    name: 'driver-profile',
  });
  const limiter = options.limiter || new RateLimiter({
    capacity: Number(process.env.QUERY_RATE_CAPACITY || 60),
    refillPerSecond: Number(process.env.QUERY_RATE_REFILL || 30),
  });
  const driverStats = { calls: 0, successes: 0, failures: 0, retries: 0, timeouts: 0 };
  const bootstrap = { state: 'NOT_STARTED', orders: 0, attempts: 0, last_error: null, completed_at: null };

  const rawDriver = options.getDriver || (id => discovery.request('driver', `/internal/drivers/${encodeURIComponent(id)}`, { timeoutMs: driverTimeoutMs, retry: false }).then(result => result.data));

  /**
   * One guarded dependency call: circuit gate -> timeout -> bounded retry ->
   * success/failure accounting. Returns a fallback value instead of throwing.
   */
  async function guardedDriver(id) {
    const started = Date.now();
    if (!breaker.allow()) {
      return { driver: null, warning: { code: 'CIRCUIT_OPEN', message: '司机资料服务正在熔断保护中，订单状态仍可查看和操作。' }, meta: { elapsed_ms: Date.now() - started, attempts: 0, circuit: 'OPEN' } };
    }
    driverStats.calls++;
    let attempts = 0;
    try {
      const data = await withRetry(async () => {
        attempts++;
        return rawDriver(id);
      }, {
        attempts: driverAttempts,
        backoffMs: 100,
        shouldRetry: error => !error.status || error.status >= 500 || error.status === 429,
        onAttempt: error => {
          driverStats.retries++;
          if (/timeout|abort/i.test(`${error.name} ${error.code} ${error.message}`)) driverStats.timeouts++;
          log('order-query', 'driver_retry', { driver_id: id, attempt: attempts, code: error.code || error.name, message: error.message });
        },
      });
      breaker.success(); driverStats.successes++;
      return { driver: data.driver, warning: null, meta: { elapsed_ms: Date.now() - started, attempts, circuit: breaker.state } };
    } catch (error) {
      breaker.failure(); driverStats.failures++;
      if (/timeout|abort/i.test(`${error.name} ${error.code} ${error.message}`) || error.code === 'DEPENDENCY_UNAVAILABLE') driverStats.timeouts++;
      log('order-query', 'driver_fallback', { driver_id: id, code: error.code, attempts, elapsed_ms: Date.now() - started, circuit: breaker.state });
      const open = breaker.state === 'OPEN';
      return {
        driver: null,
        warning: {
          code: open ? 'CIRCUIT_OPEN' : 'DRIVER_UNAVAILABLE',
          message: open
            ? '司机资料服务持续失败，已触发熔断；订单状态仍可查看和操作，稍后会自动探测恢复。'
            : '司机资料暂时不可用；订单状态仍可查看和操作，请稍后刷新。',
        },
        meta: { elapsed_ms: Date.now() - started, attempts, circuit: breaker.state, error: error.code || error.name },
      };
    }
  }

  function project(event) {
    const d = event.data;
    if (typeof event.event_id !== 'string' || event.event_id.length > 160 || typeof event.aggregate_id !== 'string' || !Number.isSafeInteger(event.version) || event.version < 1 || !d || d.id !== event.aggregate_id || d.version !== event.version || typeof d.rider_id !== 'string' || !states.includes(d.status)) {
      throw new HttpError(400, 'INVALID_EVENT', '订单事件格式不正确');
    }
    return transaction(db, () => {
      if (db.prepare('SELECT 1 FROM inbox WHERE event_id=?').get(event.event_id)) return { duplicate: true, applied: false };
      const result = db.prepare(`INSERT INTO order_views(id,rider_id,driver_id,status,version,snapshot,projected_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET rider_id=excluded.rider_id,driver_id=excluded.driver_id,status=excluded.status,
        version=excluded.version,snapshot=excluded.snapshot,projected_at=excluded.projected_at WHERE excluded.version>order_views.version`).run(d.id, d.rider_id, d.driver_id || null, d.status, d.version, JSON.stringify(d), now());
      db.prepare('INSERT INTO inbox VALUES(?,?,?,?)').run(event.event_id, d.id, event.version, now());
      log('order-query', 'event_projected', { order_id: d.id, event_id: event.event_id, version: d.version, applied: result.changes === 1 });
      return { duplicate: false, applied: result.changes === 1 };
    });
  }

  /** A new replica seeds its private read model from Order's API, never its DB. */
  async function runBootstrap() {
    bootstrap.attempts++;
    try {
      const { data } = await discovery.request('order', '/internal/orders/snapshots', { timeoutMs: 2500 });
      let applied = 0;
      transaction(db, () => {
        for (const order of data.orders || []) {
          const result = db.prepare(`INSERT INTO order_views(id,rider_id,driver_id,status,version,snapshot,projected_at) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET rider_id=excluded.rider_id,driver_id=excluded.driver_id,status=excluded.status,
            version=excluded.version,snapshot=excluded.snapshot,projected_at=excluded.projected_at WHERE excluded.version>order_views.version`)
            .run(order.id, order.rider_id, order.driver_id || null, order.status, order.version, JSON.stringify(order), now());
          applied += result.changes;
        }
      });
      Object.assign(bootstrap, { state: 'READY', orders: data.orders?.length || 0, last_error: null, completed_at: now() });
      log('order-query', 'bootstrap_ready', { orders: data.orders?.length || 0, applied });
      return true;
    } catch (error) {
      Object.assign(bootstrap, { state: 'RETRYING', last_error: error.code || error.message });
      log('order-query', 'bootstrap_retry', { attempt: bootstrap.attempts, code: error.code || error.message });
      return false;
    }
  }
  let bootstrapTimer;
  function start() {
    if (bootstrapTimer) return;
    const attempt = async () => { if (await runBootstrap()) { clearInterval(bootstrapTimer); bootstrapTimer = undefined; } };
    void attempt();
    bootstrapTimer = setInterval(attempt, 5000);
    bootstrapTimer.unref();
  }

  function authorize(order, actor) {
    if (actor.role === 'RIDER' ? order.rider_id !== actor.id : order.driver_id !== actor.id && order.pending_driver_id !== actor.id) throw new HttpError(403, 'NOT_YOUR_ORDER', '只能查询自己的订单');
  }
  const find = id => {
    const row = db.prepare('SELECT snapshot,projected_at FROM order_views WHERE id=?').get(id);
    return row ? { order: JSON.parse(row.snapshot), projected_at: row.projected_at } : null;
  };
  async function combine(found, minVersion = 0, initialWarnings = []) {
    const { order, projected_at } = found;
    const warnings = [...initialWarnings];
    let driver = null; let degradation;
    if (order.driver_id) {
      const guarded = await guardedDriver(order.driver_id);
      driver = guarded.driver;
      if (guarded.warning) { warnings.push(guarded.warning); degradation = { dependency: 'driver-service', ...guarded.meta, code: guarded.warning.code }; }
    }
    return {
      order, driver, projection_version: order.version, projected_at,
      sync_pending: order.version < minVersion, partial: warnings.length > 0, degraded: warnings.length > 0,
      warnings, ...(degradation ? { degradation } : {}),
    };
  }
  function enforceRate(actor) {
    if (limiter.take(actor.id)) return;
    const error = new HttpError(429, 'RATE_LIMITED', '查询请求过于频繁，请稍后重试');
    error.details = { scope: 'order-query', per_actor: true, ...limiter.snapshot() };
    error.headers = { 'Retry-After': '1' };
    throw error;
  }

  const routes = [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => ({
      status: 'ok', service: 'order-query', database: db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'error',
      bootstrap_state: bootstrap.state, instance_id: process.env.INSTANCE_ID || null,
    }) },
    { method: 'POST', path: '/internal/events', role: 'INTERNAL', handler: c => project(c.body) },
    { method: 'GET', path: '/internal/resilience', role: 'INTERNAL', handler: () => ({
      service: 'order-query', instance_id: process.env.INSTANCE_ID || null,
      circuit: breaker.snapshot(), rate_limit: limiter.snapshot(), driver: { ...driverStats, timeout_ms: driverTimeoutMs, max_attempts: driverAttempts },
      discovery: discovery.snapshot(), bootstrap,
    }) },
    { method: 'POST', path: '/internal/bootstrap', role: 'INTERNAL', handler: async () => { await runBootstrap(); return { ...bootstrap }; } },
    { method: 'GET', path: '/orders/history', role: 'RIDER', handler: c => ({ orders: db.prepare('SELECT snapshot FROM order_views WHERE rider_id=? ORDER BY json_extract(snapshot,\'$.created_at\') DESC LIMIT 100').all(c.actor.id).map(r => JSON.parse(r.snapshot)), source: 'order-query', eventual_consistency: true }) },
    { method: 'GET', path: '/orders/current', role: 'ANY', handler: async c => {
      enforceRate(c.actor);
      let found; const warnings = [];
      if (c.actor.role === 'DRIVER') {
        const guarded = await guardedDriver(c.actor.id);
        if (guarded.warning) warnings.push(guarded.warning);
        if (guarded.driver && !guarded.driver.active_order_id) return { order: null, sync_pending: false, partial: warnings.length > 0, warnings };
        if (guarded.driver?.active_order_id) {
          found = find(guarded.driver.active_order_id);
          if (!found) return response(202, { order: null, sync_pending: true, partial: warnings.length > 0, warnings });
        } else {
          const row = db.prepare(`SELECT id FROM order_views WHERE driver_id=? AND status IN ${activeSql} ORDER BY version DESC LIMIT 1`).get(c.actor.id);
          found = row ? find(row.id) : null;
        }
      } else {
        const row = db.prepare(`SELECT id FROM order_views WHERE rider_id=? AND status IN ${activeSql} ORDER BY json_extract(snapshot,'$.created_at') DESC LIMIT 1`).get(c.actor.id);
        found = row ? find(row.id) : null;
      }
      if (!found) return { order: null, partial: warnings.length > 0, sync_pending: false, warnings };
      authorize(found.order, c.actor); return combine(found, 0, warnings);
    } },
    { method: 'GET', path: '/orders/:id', role: 'ANY', handler: async c => {
      enforceRate(c.actor);
      const minVersion = Number(c.query.get('min_version') || 0);
      if (!Number.isSafeInteger(minVersion) || minVersion < 0) throw new HttpError(400, 'INVALID_VERSION', '查询版本须为非负整数');
      const found = find(c.params.id);
      if (!found) {
        if (minVersion > 0) return response(202, { order: null, sync_pending: true, partial: false, warnings: [] });
        throw new HttpError(404, 'ORDER_NOT_FOUND', '订单尚未同步或不存在，请稍后刷新');
      }
      authorize(found.order, c.actor);
      const result = await combine(found, minVersion);
      return result.sync_pending ? response(202, result) : result;
    } },
  ];
  const server = createServer({ service: 'order-query', routes });
  async function close() {
    clearInterval(bootstrapTimer);
    if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    db.close();
  }
  return { server, db, project, discovery, breaker, limiter, bootstrap, start, close };
}
