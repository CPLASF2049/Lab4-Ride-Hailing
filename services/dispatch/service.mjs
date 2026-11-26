import { createServer, HttpError, response } from '../../common/http.mjs';
import { openDb, migrate, transaction, uid, now } from '../../common/db.mjs';
import { Discovery } from '../../common/discovery.mjs';

const ORDER_STATES = new Set(['MATCHING', 'ASSIGNING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED']);
const TERMINAL_TASKS = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
const ACTIVE_ORDER_STATES = new Set(['MATCHING', 'ASSIGNING']);

function id(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new HttpError(400, 'INVALID_REQUEST', `${field}不能为空，且须为长度不超过200的字符串`);
  }
  return value;
}
function positiveMs(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name}须为正整数（毫秒）`);
  return value;
}
function log(orderId, action, details = {}) {
  console.log(JSON.stringify({ service: 'dispatch', order_id: orderId, action, ...details }));
}

export function createDispatch({
  dbPath = ':memory:',
  orderUrl = process.env.ORDER_URL || 'http://127.0.0.1:3101',
  driverUrl = process.env.DRIVER_URL || 'http://127.0.0.1:3103',
  registryUrl = process.env.REGISTRY_URL || '',
  internalToken = process.env.INTERNAL_TOKEN || 'lab3-local-internal',
  offerTtlMs = Number(process.env.OFFER_TTL_MS || 15000),
  dispatchWaitMs = Number(process.env.DISPATCH_WAIT_MS || 45000),
  tickMs = Number(process.env.DISPATCH_TICK_MS || process.env.TICK_MS || 300),
} = {}) {
  positiveMs(offerTtlMs, 'offerTtlMs');
  positiveMs(dispatchWaitMs, 'dispatchWaitMs');
  positiveMs(tickMs, 'tickMs');
  orderUrl = orderUrl.replace(/\/$/, '');
  driverUrl = driverUrl.replace(/\/$/, '');
  const db = openDb(dbPath);
  migrate(db, `
    CREATE TABLE IF NOT EXISTS dispatch_inbox (
      event_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_tasks (
      order_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('SEARCHING','OFFERED','CONFIRMING','COMPLETED','CANCELLED','FAILED')),
      order_status TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES dispatch_tasks(order_id),
      driver_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING','CLAIMED','ACCEPTED','REJECTED','EXPIRED','FAILED','CANCELLED')),
      assignment_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(order_id,driver_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS offers_current_order
      ON offers(order_id) WHERE status IN ('PENDING','CLAIMED');
    CREATE INDEX IF NOT EXISTS offers_driver_status ON offers(driver_id,status);
    CREATE INDEX IF NOT EXISTS dispatch_tasks_state ON dispatch_tasks(state,created_at);
  `);

  const discovery = new Discovery({ registryUrl, internalToken, staticUrls: { order: orderUrl, driver: driverUrl } });
  const rpc = (service, path, options = {}) => discovery.request(service, path, { timeoutMs: 1800, ...options }).then(result => result.data);
  const findTask = orderId => db.prepare('SELECT * FROM dispatch_tasks WHERE order_id = ?').get(orderId);
  const findOffer = offerId => db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  const currentOffer = orderId => db.prepare("SELECT * FROM offers WHERE order_id = ? AND status IN ('PENDING','CLAIMED')").get(orderId);

  function getOffer(offerId) {
    const offer = findOffer(offerId);
    if (!offer) throw new HttpError(404, 'OFFER_NOT_FOUND', '派单不存在');
    const task = findTask(offer.order_id);
    const order = JSON.parse(task.snapshot_json);
    return { ...offer, order, origin: order.origin, destination: order.destination };
  }

  function expireOffer(offer, timestamp = now()) {
    if (offer.status !== 'PENDING') return;
    db.prepare("UPDATE offers SET status = 'EXPIRED', resolved_at = ? WHERE id = ? AND status = 'PENDING'").run(timestamp, offer.id);
    // ASSIGNING may have arrived before a claim fails. Its durable saga must emit
    // the newer MATCHING event before this task can safely search again.
    db.prepare(`UPDATE dispatch_tasks SET state = 'SEARCHING', updated_at = ?
      WHERE order_id = ? AND state = 'OFFERED' AND order_status = 'MATCHING'`).run(timestamp, offer.order_id);
  }

  function validateEvent(body) {
    id(body?.event_id, 'event_id');
    id(body?.event_type, 'event_type');
    id(body?.aggregate_id, 'aggregate_id');
    if (!Number.isSafeInteger(body?.version) || body.version < 1) throw new HttpError(400, 'INVALID_EVENT', '事件版本须为正整数');
    if (typeof body?.occurred_at !== 'string' || !Number.isFinite(Date.parse(body.occurred_at))) {
      throw new HttpError(400, 'INVALID_EVENT', '事件发生时间须为有效时间戳');
    }
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)
      || body.data.id !== body.aggregate_id || body.data.version !== body.version || !ORDER_STATES.has(body.data.status)) {
      throw new HttpError(400, 'INVALID_EVENT', '事件须包含编号和版本一致的完整订单快照');
    }
  }

  function ingestEvent(body) {
    validateEvent(body);
    return transaction(db, () => {
      if (db.prepare('SELECT event_id FROM dispatch_inbox WHERE event_id = ?').get(body.event_id)) {
        return { received: true, duplicate: true, applied: false };
      }
      const timestamp = now();
      db.prepare('INSERT INTO dispatch_inbox (event_id,order_id,version,received_at) VALUES (?,?,?,?)')
        .run(body.event_id, body.aggregate_id, body.version, timestamp);
      const previous = findTask(body.aggregate_id);
      if (previous && previous.version >= body.version) return { received: true, duplicate: false, applied: false };
      const order = body.data;
      const createdAt = Number.isFinite(Date.parse(order.created_at)) ? order.created_at : body.occurred_at;
      const deadlineAt = previous?.deadline_at || new Date(Date.parse(createdAt) + dispatchWaitMs).toISOString();
      let state;
      if (order.status === 'CANCELLED' || order.status === 'FAILED') state = order.status;
      else if (order.status === 'ASSIGNING') state = 'CONFIRMING';
      else if (order.status !== 'MATCHING') state = 'COMPLETED';
      else if (previous && TERMINAL_TASKS.has(previous.state)) state = previous.state;
      else {
        const active = currentOffer(order.id);
        state = active?.status === 'CLAIMED' ? 'CONFIRMING' : active ? 'OFFERED' : 'SEARCHING';
      }
      db.prepare(`INSERT INTO dispatch_tasks
        (order_id,state,order_status,version,snapshot_json,deadline_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,order_status=excluded.order_status,
          version=excluded.version,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at,last_error=NULL`)
        .run(order.id, state, order.status, body.version, JSON.stringify(order), deadlineAt, createdAt, timestamp);
      if (order.status === 'CANCELLED' || order.status === 'FAILED') {
        db.prepare("UPDATE offers SET status = 'CANCELLED', resolved_at = ? WHERE order_id = ? AND status IN ('PENDING','CLAIMED')")
          .run(timestamp, order.id);
      } else if (!ACTIVE_ORDER_STATES.has(order.status)) {
        // Order is authoritative when its accepted event beats the resolve RPC.
        if (order.offer_id) {
          db.prepare(`UPDATE offers SET status = 'ACCEPTED', assignment_id = COALESCE(assignment_id,?), resolved_at = ?
            WHERE id = ? AND order_id = ? AND driver_id = ? AND status IN ('PENDING','CLAIMED')`)
            .run(order.assignment_id || null, timestamp, order.offer_id, order.id, order.driver_id);
        }
        db.prepare("UPDATE offers SET status = 'CANCELLED', resolved_at = ? WHERE order_id = ? AND status IN ('PENDING','CLAIMED')")
          .run(timestamp, order.id);
      }
      log(order.id, 'event_applied', { version: body.version, status: order.status });
      return { received: true, duplicate: false, applied: true };
    });
  }

  function claimOffer(offerId, body) {
    const orderId = id(body?.order_id, 'order_id');
    const driverId = id(body?.driver_id, 'driver_id');
    const assignmentId = id(body?.assignment_id, 'assignment_id');
    const result = transaction(db, () => {
      const offer = findOffer(offerId);
      if (!offer) throw new HttpError(404, 'OFFER_NOT_FOUND', '派单不存在');
      if (offer.order_id !== orderId || offer.driver_id !== driverId) {
        throw new HttpError(409, 'OFFER_UNAVAILABLE', '派单不属于指定订单或司机');
      }
      if (offer.assignment_id === assignmentId && (offer.status === 'CLAIMED' || offer.status === 'ACCEPTED')) {
        return { offer: getOffer(offerId), claimed: true };
      }
      const task = findTask(orderId);
      if (offer.status !== 'PENDING' || offer.assignment_id || TERMINAL_TASKS.has(task.state) || !ACTIVE_ORDER_STATES.has(task.order_status)) {
        throw new HttpError(409, 'OFFER_UNAVAILABLE', '派单已失效，请刷新列表');
      }
      if (Date.parse(offer.expires_at) <= Date.now()) {
        expireOffer(offer);
        return { expired: true };
      }
      if (db.prepare('SELECT id FROM offers WHERE assignment_id = ?').get(assignmentId)) {
        throw new HttpError(409, 'ASSIGNMENT_CONFLICT', '该司机分配标识已用于其他派单');
      }
      db.prepare("UPDATE offers SET status = 'CLAIMED', assignment_id = ? WHERE id = ?").run(assignmentId, offerId);
      db.prepare("UPDATE dispatch_tasks SET state = 'CONFIRMING', updated_at = ?, last_error = NULL WHERE order_id = ?")
        .run(now(), orderId);
      return { offer: getOffer(offerId), claimed: true };
    });
    if (result.expired) throw new HttpError(409, 'OFFER_EXPIRED', '派单已过期，请刷新列表');
    log(orderId, 'offer_claimed', { offer_id: offerId, assignment_id: assignmentId });
    return result;
  }

  function resolveOffer(offerId, body) {
    const assignmentId = id(body?.assignment_id, 'assignment_id');
    if (body?.status !== 'FAILED' && body?.status !== 'ACCEPTED') {
      throw new HttpError(400, 'INVALID_REQUEST', '派单处理结果须为FAILED或ACCEPTED');
    }
    return transaction(db, () => {
      const offer = findOffer(offerId);
      if (!offer) throw new HttpError(404, 'OFFER_NOT_FOUND', '派单不存在');
      if (offer.assignment_id !== assignmentId) throw new HttpError(409, 'OFFER_UNAVAILABLE', '该司机分配标识不属于当前派单');
      const task = findTask(offer.order_id);
      if (offer.status === body.status || TERMINAL_TASKS.has(task.state)) return { offer: getOffer(offerId), resolved: true };
      if (offer.status !== 'CLAIMED') throw new HttpError(409, 'OFFER_UNAVAILABLE', '派单确认已结束，不能重复处理');
      const timestamp = now();
      db.prepare('UPDATE offers SET status = ?, resolved_at = ? WHERE id = ?').run(body.status, timestamp, offerId);
      // A failed saga may resolve before its newer MATCHING event reaches this inbox.
      db.prepare('UPDATE dispatch_tasks SET state = ?, updated_at = ?, last_error = NULL WHERE order_id = ?')
        .run(body.status === 'FAILED' ? 'SEARCHING' : 'COMPLETED', timestamp, offer.order_id);
      log(offer.order_id, 'offer_resolved', { offer_id: offerId, status: body.status });
      return { offer: getOffer(offerId), resolved: true };
    });
  }

  let closed = false;
  let timer;
  let busy = false;
  let activeTick;

  async function failMatching(orderId, reason) {
    const task = findTask(orderId);
    if (!task || TERMINAL_TASKS.has(task.state) || task.state === 'CONFIRMING' || task.order_status === 'ASSIGNING') return;
    if (currentOffer(orderId)?.status === 'CLAIMED') return;
    const result = await rpc('order', `/internal/orders/${encodeURIComponent(orderId)}/fail-matching`, { method: 'POST', body: { reason }, retry: false });
    transaction(db, () => {
      const current = findTask(orderId);
      if (!current || TERMINAL_TASKS.has(current.state) || current.state === 'CONFIRMING' || currentOffer(orderId)?.status === 'CLAIMED') return;
      const upstreamOrder = result?.order;
      if (upstreamOrder?.status === 'ASSIGNING') {
        db.prepare("UPDATE dispatch_tasks SET state = 'CONFIRMING', updated_at = ? WHERE order_id = ?").run(now(), orderId);
        return;
      }
      const state = upstreamOrder?.status === 'CANCELLED' ? 'CANCELLED'
        : upstreamOrder && !['MATCHING', 'FAILED'].includes(upstreamOrder.status) ? 'COMPLETED' : 'FAILED';
      const timestamp = now();
      db.prepare('UPDATE dispatch_tasks SET state = ?, updated_at = ?, last_error = NULL WHERE order_id = ?')
        .run(state, timestamp, orderId);
      db.prepare("UPDATE offers SET status = 'CANCELLED', resolved_at = ? WHERE order_id = ? AND status = 'PENDING'")
        .run(timestamp, orderId);
      log(orderId, 'matching_failed', { reason });
    });
  }

  async function step(orderId) {
    let task = findTask(orderId);
    if (!task || TERMINAL_TASKS.has(task.state) || task.state === 'CONFIRMING' || task.order_status === 'ASSIGNING') return;
    let offer = currentOffer(orderId);
    if (offer?.status === 'CLAIMED') {
      db.prepare("UPDATE dispatch_tasks SET state = 'CONFIRMING', updated_at = ? WHERE order_id = ?").run(now(), orderId);
      return;
    }
    if (offer && Date.parse(offer.expires_at) <= Date.now()) {
      transaction(db, () => expireOffer(offer));
      log(orderId, 'offer_expired', { offer_id: offer.id });
      offer = undefined;
      task = findTask(orderId);
    }
    if (Date.parse(task.deadline_at) <= Date.now()) {
      await failMatching(orderId, 'MATCH_TIMEOUT');
      return;
    }
    if (offer) return;
    if (task.state !== 'SEARCHING' || task.order_status !== 'MATCHING') return;

    const result = await rpc('driver', '/internal/drivers');
    if (!Array.isArray(result?.drivers)) throw new HttpError(502, 'BAD_UPSTREAM_RESPONSE', '司机服务返回的数据格式无效，请稍后重试');
    if (closed) return;
    task = findTask(orderId);
    if (!task || task.state !== 'SEARCHING' || task.order_status !== 'MATCHING' || currentOffer(orderId)) return;
    if (Date.parse(task.deadline_at) <= Date.now()) {
      await failMatching(orderId, 'MATCH_TIMEOUT');
      return;
    }
    const tried = new Set(db.prepare('SELECT driver_id FROM offers WHERE order_id = ?').all(orderId).map(row => row.driver_id));
    const candidates = result.drivers.filter(driver => typeof driver.id === 'string' && driver.online === true
      && driver.active_order_id == null && driver.active_assignment_id == null && !tried.has(driver.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!candidates.length) {
      await failMatching(orderId, tried.size ? 'ALL_REJECTED' : 'NO_DRIVER');
      return;
    }
    const candidate = candidates[0];
    transaction(db, () => {
      const current = findTask(orderId);
      if (!current || current.state !== 'SEARCHING' || current.order_status !== 'MATCHING' || currentOffer(orderId)) return;
      const timestamp = now();
      const expiresAt = new Date(Math.min(Date.parse(timestamp) + offerTtlMs, Date.parse(current.deadline_at))).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(timestamp)) return;
      const offerId = uid('offer');
      db.prepare(`INSERT INTO offers (id,order_id,driver_id,status,created_at,expires_at)
        VALUES (?,?,?,'PENDING',?,?)`).run(offerId, orderId, candidate.id, timestamp, expiresAt);
      db.prepare("UPDATE dispatch_tasks SET state = 'OFFERED', updated_at = ?, last_error = NULL WHERE order_id = ?")
        .run(timestamp, orderId);
      log(orderId, 'offer_created', { offer_id: offerId, driver_id: candidate.id });
    });
  }

  async function runTick() {
    const tasks = db.prepare("SELECT order_id FROM dispatch_tasks WHERE state IN ('SEARCHING','OFFERED','CONFIRMING') ORDER BY created_at,order_id").all();
    for (const { order_id: orderId } of tasks) {
      if (closed) break;
      try { await step(orderId); }
      catch (error) {
        const message = `${error.code || 'ERROR'}: ${error.message}`;
        db.prepare('UPDATE dispatch_tasks SET last_error = ?, updated_at = ? WHERE order_id = ?').run(message, now(), orderId);
        log(orderId, 'worker_retry', { code: error.code || 'ERROR' });
      }
    }
  }
  function tick() {
    if (closed || busy) return Promise.resolve();
    busy = true;
    activeTick = runTick().finally(() => { busy = false; activeTick = undefined; });
    return activeTick;
  }
  function startWorkers() {
    if (closed || timer) return;
    timer = setInterval(() => void tick(), tickMs);
    timer.unref();
    void tick();
  }

  const server = createServer({ service: 'dispatch', routes: [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => {
      db.prepare('SELECT 1').get();
      return { service: 'dispatch', status: 'ok' };
    } },
    { method: 'GET', path: '/drivers/me/offers', role: 'DRIVER', handler: ({ actor }) => {
      const timestamp = now();
      const rows = db.prepare(`SELECT o.id FROM offers o JOIN dispatch_tasks t ON t.order_id = o.order_id
        WHERE o.driver_id = ? AND t.state IN ('OFFERED','CONFIRMING') AND t.order_status IN ('MATCHING','ASSIGNING')
          AND (o.status = 'CLAIMED' OR (o.status = 'PENDING' AND o.expires_at > ?))
        ORDER BY o.created_at,o.id`).all(actor.id, timestamp);
      return { offers: rows.map(row => getOffer(row.id)) };
    } },
    { method: 'POST', path: '/offers/:id/accept', role: 'DRIVER', handler: async ({ params, actor, requestId }) => {
      const offer = getOffer(params.id);
      if (offer.driver_id !== actor.id) throw new HttpError(403, 'FORBIDDEN', '只能操作派发给自己的订单');
      const task = findTask(offer.order_id);
      if (!['PENDING', 'CLAIMED', 'ACCEPTED'].includes(offer.status) || ['CANCELLED', 'FAILED'].includes(task.state)) {
        throw new HttpError(409, 'OFFER_UNAVAILABLE', '派单已失效，请刷新列表');
      }
      if (offer.status === 'PENDING' && Date.parse(offer.expires_at) <= Date.now()) {
        transaction(db, () => expireOffer(offer));
        throw new HttpError(409, 'OFFER_EXPIRED', '派单已过期，请刷新列表');
      }
      const result = await rpc('order', `/internal/orders/${encodeURIComponent(offer.order_id)}/accept`, {
        method: 'POST', body: { driver_id: actor.id, offer_id: offer.id }, headers: { 'X-Request-ID': requestId }, retry: false,
      });
      return response(result?.order?.status === 'ASSIGNING' ? 202 : 200, result);
    } },
    { method: 'POST', path: '/offers/:id/reject', role: 'DRIVER', handler: ({ params, actor }) => {
      const result = transaction(db, () => {
        const offer = findOffer(params.id);
        if (!offer) throw new HttpError(404, 'OFFER_NOT_FOUND', '派单不存在');
        if (offer.driver_id !== actor.id) throw new HttpError(403, 'FORBIDDEN', '只能操作派发给自己的订单');
        const task = findTask(offer.order_id);
        if (offer.status !== 'PENDING' || task.state === 'CONFIRMING' || TERMINAL_TASKS.has(task.state)) {
          throw new HttpError(409, 'OFFER_UNAVAILABLE', '只能拒绝尚未确认的派单');
        }
        if (Date.parse(offer.expires_at) <= Date.now()) {
          expireOffer(offer);
          return { expired: true };
        }
        const timestamp = now();
        db.prepare("UPDATE offers SET status = 'REJECTED', resolved_at = ? WHERE id = ?").run(timestamp, offer.id);
        db.prepare("UPDATE dispatch_tasks SET state = 'SEARCHING', updated_at = ?, last_error = NULL WHERE order_id = ?")
          .run(timestamp, offer.order_id);
        log(offer.order_id, 'offer_rejected', { offer_id: offer.id, driver_id: actor.id });
        return { offer: getOffer(offer.id) };
      });
      if (result.expired) throw new HttpError(409, 'OFFER_EXPIRED', '派单已过期，请刷新列表');
      return result;
    } },
    { method: 'POST', path: '/internal/events', role: 'INTERNAL', handler: ({ body }) => ingestEvent(body) },
    { method: 'GET', path: '/internal/offers/:id', role: 'INTERNAL', handler: ({ params }) => ({ offer: getOffer(params.id) }) },
    { method: 'POST', path: '/internal/offers/:id/claim', role: 'INTERNAL', handler: ({ params, body }) => claimOffer(params.id, body) },
    { method: 'POST', path: '/internal/offers/:id/resolve', role: 'INTERNAL', handler: ({ params, body }) => resolveOffer(params.id, body) },
  ] });

  async function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (activeTick) await activeTick;
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
  return { server, db, startWorkers, tick, close };
}
