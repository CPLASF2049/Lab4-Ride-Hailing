import { openDb, migrate, transaction, now } from '../../common/db.mjs';
import { config } from '../../common/config.mjs';
import { createServer, HttpError, response, log } from '../../common/http.mjs';
import { Discovery } from '../../common/discovery.mjs';
import { CircuitBreaker, RateLimiter, withRetry } from '../../common/resilience.mjs';
import { isOrderSnapshot, validateOrderEvent } from '../../common/order-event.mjs';

const activeSql = "('MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS')";

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
  const bootstrap = {
    state: 'NOT_STARTED', orders: 0, attempts: 0, cursor: null,
    last_error: null, completed_at: null, last_synced_at: null,
  };
  let requireBootstrap = options.requireBootstrap ?? false;
  const readyToRead = () => !requireBootstrap || bootstrap.state === 'READY';

  const rawDriver = options.getDriver || (id => discovery.request('driver', `/internal/drivers/${encodeURIComponent(id)}`, { timeoutMs: driverTimeoutMs, retry: false }).then(result => result.data));

  /**
   * One guarded dependency call: circuit gate -> timeout -> bounded retry ->
   * success/failure accounting. Returns a fallback value instead of throwing.
   */
  async function guardedDriver(id, { needsOccupancy = false } = {}) {
    const started = Date.now();
    const permit = breaker.begin();
    if (!permit) {
      return { driver: null, warning: { code: 'CIRCUIT_OPEN', message: '司机资料服务正在熔断保护中，订单状态仍可查看和操作。' }, meta: { elapsed_ms: Date.now() - started, attempts: 0, circuit: breaker.state } };
    }
    driverStats.calls++;
    let attempts = 0;
    try {
      const driver = await withRetry(async () => {
        attempts++;
        const data = await rawDriver(id);
        const driver = data?.driver;
        if (!driver || typeof driver !== 'object' || Array.isArray(driver) || driver.id !== id) {
          throw new HttpError(502, 'BAD_UPSTREAM_RESPONSE', '司机资料格式无效');
        }
        if (needsOccupancy && driver.active_order_id !== null
            && (typeof driver.active_order_id !== 'string' || !driver.active_order_id.trim())) {
          throw new HttpError(502, 'BAD_UPSTREAM_RESPONSE', '司机占用状态格式无效');
        }
        return driver;
      }, {
        attempts: permit.probe ? 1 : driverAttempts,
        backoffMs: 100,
        shouldRetry: error => !error.status || error.status >= 500 || error.status === 429,
        onAttempt: error => {
          driverStats.retries++;
          if (/timeout|abort/i.test(`${error.name} ${error.code} ${error.message}`)) driverStats.timeouts++;
          log('order-query', 'driver_retry', { driver_id: id, attempt: attempts, code: error.code || error.name, message: error.message });
        },
      });
      breaker.success(permit); driverStats.successes++;
      return { driver, warning: null, meta: { elapsed_ms: Date.now() - started, attempts, circuit: breaker.state } };
    } catch (error) {
      breaker.failure(permit); driverStats.failures++;
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

  const upsertSnapshot = db.prepare(`INSERT INTO order_views(id,rider_id,driver_id,status,version,snapshot,projected_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      rider_id=excluded.rider_id,driver_id=excluded.driver_id,status=excluded.status,
      version=excluded.version,snapshot=excluded.snapshot,projected_at=excluded.projected_at
    WHERE excluded.version>order_views.version`);
  const applySnapshot = order => upsertSnapshot.run(
    order.id, order.rider_id, order.driver_id ?? null, order.status, order.version, JSON.stringify(order), now(),
  ).changes;

  function project(event) {
    validateOrderEvent(event);
    const d = event.data;
    return transaction(db, () => {
      if (db.prepare('SELECT 1 FROM inbox WHERE event_id=?').get(event.event_id)) return { duplicate: true, applied: false };
      const applied = applySnapshot(d) === 1;
      db.prepare('INSERT INTO inbox VALUES(?,?,?,?)').run(event.event_id, d.id, event.version, now());
      log('order-query', 'event_projected', { order_id: d.id, event_id: event.event_id, version: d.version, applied });
      return { duplicate: false, applied };
    });
  }

  /** Seed from Order once, then reconcile missed deliveries with bounded snapshot pages. */
  async function refreshProjection() {
    const cursor = bootstrap.cursor;
    const initial = cursor === null;
    if (initial) {
      bootstrap.state = 'SYNCING';
      bootstrap.attempts++;
    }
    try {
      const path = initial ? '/internal/orders/snapshots' : `/internal/orders/snapshots?after=${cursor}`;
      const { data } = await discovery.request('order', path, { timeoutMs: 2500 });
      if (!Number.isSafeInteger(data?.cursor) || data.cursor < (cursor ?? 0)
          || !Array.isArray(data.orders) || !data.orders.every(isOrderSnapshot)) {
        throw new HttpError(502, 'INVALID_SNAPSHOT_PAGE', '订单快照或同步游标格式无效');
      }
      const applied = data.orders.length
        ? transaction(db, () => data.orders.reduce((count, order) => count + applySnapshot(order), 0))
        : 0;
      const syncedAt = now();
      Object.assign(bootstrap, { cursor: data.cursor, last_error: null, last_synced_at: syncedAt });
      if (initial) {
        Object.assign(bootstrap, { state: 'READY', orders: data.orders.length, completed_at: syncedAt });
        log('order-query', 'bootstrap_ready', { orders: data.orders.length, applied, cursor: data.cursor });
      } else if (applied) {
        log('order-query', 'projection_caught_up', { orders: applied, cursor: data.cursor });
      }
    } catch (error) {
      const code = error.code || error.message;
      if (initial) bootstrap.state = 'RETRYING';
      if (initial || bootstrap.last_error !== code) log('order-query', initial ? 'bootstrap_retry' : 'projection_sync_retry', { cursor, code });
      bootstrap.last_error = code;
    }
  }
  let syncTimer, pendingSync;
  function synchronize() {
    if (!pendingSync) {
      pendingSync = refreshProjection().finally(() => { pendingSync = undefined; });
    }
    return pendingSync;
  }
  function start() {
    if (syncTimer) return;
    requireBootstrap = true;
    void synchronize();
    syncTimer = setInterval(synchronize, options.replicaSyncMs ?? 2000);
    syncTimer.unref();
  }

  function assertReady() {
    if (readyToRead()) return;
    const error = new HttpError(503, 'QUERY_BOOTSTRAPPING', '订单查询副本正在同步，请稍后重试');
    error.headers = { 'Retry-After': '1' };
    throw error;
  }

  function authorize(order, actor) {
    if (actor.role === 'RIDER' ? order.rider_id !== actor.id : order.driver_id !== actor.id && order.pending_driver_id !== actor.id) throw new HttpError(403, 'NOT_YOUR_ORDER', '只能查询自己的订单');
  }
  const find = id => {
    const row = db.prepare('SELECT snapshot,projected_at FROM order_views WHERE id=?').get(id);
    return row ? { order: JSON.parse(row.snapshot), projected_at: row.projected_at } : null;
  };
  async function combine(found, minVersion = 0, driverLookup) {
    const { order, projected_at } = found;
    const lookup = driverLookup ?? (order.driver_id ? await guardedDriver(order.driver_id) : null);
    const warnings = lookup?.warning ? [lookup.warning] : [];
    const degradation = lookup?.warning
      ? { dependency: 'driver-service', ...lookup.meta, code: lookup.warning.code }
      : null;
    return {
      order, driver: order.driver_id ? lookup?.driver ?? null : null, projection_version: order.version, projected_at,
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
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => response(readyToRead() ? 200 : 503, {
      status: readyToRead() ? 'ok' : 'starting', service: 'order-query', database: db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'error',
      bootstrap_state: bootstrap.state, instance_id: process.env.INSTANCE_ID || null,
    }) },
    { method: 'POST', path: '/internal/events', role: 'INTERNAL', handler: c => project(c.body) },
    { method: 'GET', path: '/internal/resilience', role: 'INTERNAL', handler: () => ({
      service: 'order-query', instance_id: process.env.INSTANCE_ID || null,
      circuit: breaker.snapshot(), rate_limit: limiter.snapshot(), driver: { ...driverStats, timeout_ms: driverTimeoutMs, max_attempts: driverAttempts },
      discovery: discovery.snapshot(), bootstrap,
    }) },
    { method: 'POST', path: '/internal/bootstrap', role: 'INTERNAL', handler: async () => { await synchronize(); return { ...bootstrap }; } },
    { method: 'GET', path: '/orders/history', role: 'RIDER', handler: c => {
      assertReady();
      return { orders: db.prepare('SELECT snapshot FROM order_views WHERE rider_id=? ORDER BY json_extract(snapshot,\'$.created_at\') DESC LIMIT 100').all(c.actor.id).map(r => JSON.parse(r.snapshot)), source: 'order-query', eventual_consistency: true };
    } },
    { method: 'GET', path: '/orders/current', role: 'ANY', handler: async c => {
      assertReady();
      enforceRate(c.actor);
      let found; let lookup;
      const warnings = [];
      if (c.actor.role === 'DRIVER') {
        lookup = await guardedDriver(c.actor.id, { needsOccupancy: true });
        if (lookup.warning) warnings.push(lookup.warning);
        if (lookup.driver && lookup.driver.active_order_id === null) return { order: null, sync_pending: false, partial: false, warnings };
        if (lookup.driver) {
          found = find(lookup.driver.active_order_id);
          if (!found) return response(202, { order: null, sync_pending: true, partial: warnings.length > 0, warnings });
        } else {
          const row = db.prepare(`SELECT id FROM order_views WHERE driver_id=? AND status IN ${activeSql}
            ORDER BY json_extract(snapshot,'$.created_at') DESC,id DESC LIMIT 1`).get(c.actor.id);
          found = row ? find(row.id) : null;
        }
      } else {
        const row = db.prepare(`SELECT id FROM order_views WHERE rider_id=? AND status IN ${activeSql} ORDER BY json_extract(snapshot,'$.created_at') DESC LIMIT 1`).get(c.actor.id);
        found = row ? find(row.id) : null;
      }
      if (!found) return { order: null, partial: warnings.length > 0, sync_pending: false, warnings };
      authorize(found.order, c.actor); return combine(found, 0, lookup);
    } },
    { method: 'GET', path: '/orders/:id', role: 'ANY', handler: async c => {
      assertReady();
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
    clearInterval(syncTimer);
    if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await pendingSync;
    db.close();
  }
  return { server, db, project, discovery, breaker, limiter, bootstrap, start, close };
}
