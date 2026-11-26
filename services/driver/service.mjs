import { createServer, HttpError } from '../../common/http.mjs';
import { openDb, migrate, transaction, now } from '../../common/db.mjs';

const SEED_DRIVERS = [
  { id: 'driver-1', name: '王师傅', phone_mask: '138****1001', vehicle: { plate: '沪A·L3101', model: '大众朗逸', color: '白色' } },
  { id: 'driver-2', name: '赵师傅', phone_mask: '139****1002', vehicle: { plate: '沪B·L3102', model: '别克英朗', color: '银色' } },
];

function requiredId(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new HttpError(400, 'INVALID_REQUEST', `${field}不能为空，且须为长度不超过200的字符串`);
  }
  return value;
}

function log(orderId, action) {
  console.log(JSON.stringify({ service: 'driver', order_id: orderId, action }));
}

export function createDriver({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  migrate(db, `
    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone_mask TEXT NOT NULL,
      vehicle_json TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0,1)),
      active_order_id TEXT,
      active_assignment_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((active_order_id IS NULL) = (active_assignment_id IS NULL))
    );
    CREATE TABLE IF NOT EXISTS reservations (
      assignment_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      driver_id TEXT NOT NULL REFERENCES drivers(id),
      state TEXT NOT NULL CHECK (state IN ('RESERVED','RELEASED')),
      created_at TEXT NOT NULL,
      released_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reservations_active_order
      ON reservations(order_id) WHERE state = 'RESERVED';
    CREATE UNIQUE INDEX IF NOT EXISTS reservations_active_driver
      ON reservations(driver_id) WHERE state = 'RESERVED';
  `);
  const insertDriver = db.prepare(`INSERT OR IGNORE INTO drivers
    (id,name,phone_mask,vehicle_json,updated_at) VALUES (?,?,?,?,?)`);
  transaction(db, () => {
    for (const driver of SEED_DRIVERS) {
      insertDriver.run(driver.id, driver.name, driver.phone_mask, JSON.stringify(driver.vehicle), now());
    }
  });

  function getDriver(id) {
    const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'DRIVER_NOT_FOUND', '司机不存在');
    return {
      id: row.id, name: row.name, phone_mask: row.phone_mask,
      vehicle: JSON.parse(row.vehicle_json), online: Boolean(row.online),
      active_order_id: row.active_order_id, active_assignment_id: row.active_assignment_id,
      updated_at: row.updated_at,
    };
  }

  function validateReservation(body) {
    return {
      orderId: requiredId(body?.order_id, 'order_id'),
      assignmentId: requiredId(body?.assignment_id, 'assignment_id'),
    };
  }

  function checkIdentity(reservation, driverId, orderId) {
    if (reservation && (reservation.driver_id !== driverId || reservation.order_id !== orderId)) {
      throw new HttpError(409, 'ASSIGNMENT_CONFLICT', '该司机分配标识已用于其他订单或司机');
    }
  }

  const server = createServer({ service: 'driver', routes: [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => {
      db.prepare('SELECT 1').get();
      return { service: 'driver', status: 'ok' };
    } },
    { method: 'GET', path: '/drivers/me', role: 'DRIVER', handler: ({ actor }) => ({ driver: getDriver(actor.id) }) },
    { method: 'PUT', path: '/drivers/me/status', role: 'DRIVER', handler: ({ actor, body }) => {
      if (typeof body?.online !== 'boolean') {
        throw new HttpError(400, 'INVALID_REQUEST', '上线状态须为布尔值（true或false）');
      }
      getDriver(actor.id);
      // Availability is independent of occupation: going offline never releases a trip.
      db.prepare('UPDATE drivers SET online = ?, updated_at = ? WHERE id = ?')
        .run(Number(body.online), now(), actor.id);
      return { driver: getDriver(actor.id) };
    } },
    { method: 'GET', path: '/internal/drivers', role: 'INTERNAL', handler: () => ({
      drivers: db.prepare('SELECT id FROM drivers ORDER BY id').all().map(({ id }) => getDriver(id)),
    }) },
    { method: 'GET', path: '/internal/drivers/:id', role: 'INTERNAL', handler: ({ params }) => ({ driver: getDriver(params.id) }) },
    { method: 'POST', path: '/internal/drivers/:id/reserve', role: 'INTERNAL', handler: ({ params, body }) => {
      const { orderId, assignmentId } = validateReservation(body);
      const driver = transaction(db, () => {
        const current = getDriver(params.id);
        const reservation = db.prepare('SELECT * FROM reservations WHERE assignment_id = ?').get(assignmentId);
        checkIdentity(reservation, params.id, orderId);
        if (reservation?.state === 'RELEASED') {
          throw new HttpError(409, 'RESERVATION_RELEASED', '该司机占用已释放，不能重复预占');
        }
        if (reservation?.state === 'RESERVED') return current;
        if (current.active_order_id !== null) {
          throw new HttpError(409, 'DRIVER_BUSY', '司机已有进行中的订单');
        }
        if (!current.online) throw new HttpError(409, 'DRIVER_OFFLINE', '司机当前离线，无法接单');
        const occupiedOrder = db.prepare("SELECT assignment_id FROM reservations WHERE order_id = ? AND state = 'RESERVED'").get(orderId);
        if (occupiedOrder) throw new HttpError(409, 'DRIVER_BUSY', '该订单已预占其他司机');
        const createdAt = now();
        db.prepare(`INSERT INTO reservations (assignment_id,order_id,driver_id,state,created_at)
          VALUES (?,?,?,'RESERVED',?)`).run(assignmentId, orderId, params.id, createdAt);
        db.prepare('UPDATE drivers SET active_order_id = ?, active_assignment_id = ?, updated_at = ? WHERE id = ?')
          .run(orderId, assignmentId, createdAt, params.id);
        return getDriver(params.id);
      });
      log(orderId, 'reserved');
      return { driver, reserved: true };
    } },
    { method: 'POST', path: '/internal/drivers/:id/release', role: 'INTERNAL', handler: ({ params, body }) => {
      const { orderId, assignmentId } = validateReservation(body);
      const driver = transaction(db, () => {
        getDriver(params.id);
        const reservation = db.prepare('SELECT * FROM reservations WHERE assignment_id = ?').get(assignmentId);
        checkIdentity(reservation, params.id, orderId);
        const releasedAt = now();
        if (!reservation) {
          // A release can arrive before the delayed reserve RPC; keep its tombstone forever.
          db.prepare(`INSERT INTO reservations (assignment_id,order_id,driver_id,state,created_at,released_at)
            VALUES (?,?,?,'RELEASED',?,?)`).run(assignmentId, orderId, params.id, releasedAt, releasedAt);
        } else if (reservation.state !== 'RELEASED') {
          db.prepare("UPDATE reservations SET state = 'RELEASED', released_at = ? WHERE assignment_id = ?")
            .run(releasedAt, assignmentId);
        }
        db.prepare(`UPDATE drivers SET active_order_id = NULL, active_assignment_id = NULL, updated_at = ?
          WHERE id = ? AND active_order_id = ? AND active_assignment_id = ?`)
          .run(releasedAt, params.id, orderId, assignmentId);
        return getDriver(params.id);
      });
      log(orderId, 'released');
      return { driver, released: true };
    } },
  ] });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
  return { server, db, startWorkers() {}, close };
}
