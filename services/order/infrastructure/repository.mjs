import { migrate, transaction, uid, now } from '../../../common/db.mjs';
import { HttpError } from '../../../common/http.mjs';
import { Order } from '../domain/order.mjs';

export class OrderRepository {
  constructor(db, destinations) {
    this.db = db; this.destinations = destinations;
    migrate(db, `
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, driver_id TEXT, status TEXT NOT NULL,
        version INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_order_per_rider ON orders(rider_id)
        WHERE status IN ('MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS');
      CREATE TABLE IF NOT EXISTS requests (
        rider_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, order_id TEXT NOT NULL,
        PRIMARY KEY(rider_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id,destination)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, order_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS state_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, version INTEGER NOT NULL,
        status TEXT NOT NULL, event_id TEXT NOT NULL, changed_at TEXT NOT NULL,
        UNIQUE(order_id,version)
      );
    `);
  }
  get(id) {
    const row = this.db.prepare('SELECT snapshot FROM orders WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
    return JSON.parse(row.snapshot);
  }
  findRequest(riderId, key, hash) {
    const old = this.db.prepare('SELECT * FROM requests WHERE rider_id=? AND request_key=?').get(riderId, key);
    if (!old) return null;
    if (old.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的叫车内容');
    return this.get(old.order_id);
  }
  create(order, key, hash) {
    return transaction(this.db, () => {
      const replay = this.findRequest(order.data.rider_id, key, hash);
      if (replay) return replay;
      const active = this.db.prepare("SELECT id FROM orders WHERE rider_id=? AND status IN ('MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS')").get(order.data.rider_id);
      if (active) throw new HttpError(409, 'ACTIVE_ORDER_EXISTS', '你已有进行中的叫车或行程', { order_id: active.id });
      const d = order.data;
      this.db.prepare('INSERT INTO orders(id,rider_id,driver_id,status,version,snapshot) VALUES(?,?,?,?,?,?)').run(d.id, d.rider_id, d.driver_id, d.status, d.version, JSON.stringify(d));
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(d.rider_id, key, hash, d.id);
      this.emit(d, 'order.created.v1'); return d;
    });
  }
  change(id, mutate) {
    return transaction(this.db, () => {
      const root = new Order(this.get(id)); const before = root.data.version;
      const extraJobs = mutate(root) || [];
      if (root.data.version !== before) {
        const d = root.data;
        const result = this.db.prepare('UPDATE orders SET driver_id=?,status=?,version=?,snapshot=? WHERE id=? AND version=?').run(d.driver_id, d.status, d.version, JSON.stringify(d), id, before);
        if (result.changes !== 1) throw new HttpError(409, 'VERSION_CONFLICT', '订单状态已变化，请刷新后重试');
        this.emit(d, 'order.changed.v1');
      }
      for (const job of extraJobs) this.addJob(job);
      return root.data;
    });
  }
  emit(order, type) {
    const event = { event_id: uid('evt'), event_type: type, aggregate_id: order.id, version: order.version, occurred_at: order.updated_at, trace_id: order.id, data: order };
    for (const destination of this.destinations) this.db.prepare('INSERT INTO outbox(event_id,destination,payload) VALUES(?,?,?)').run(event.event_id, destination, JSON.stringify(event));
    this.db.prepare('INSERT INTO state_log(order_id,version,status,event_id,changed_at) VALUES(?,?,?,?,?)').run(order.id, order.version, order.status, event.event_id, order.updated_at);
  }
  addJob(job) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,type,order_id,payload,created_at) VALUES(?,?,?,?,?)').run(job.id, job.type, job.order_id, JSON.stringify(job.payload), now());
  }
  health() { return this.db.prepare('SELECT 1 AS ok').get().ok === 1; }
  snapshots(after) {
    if (after === undefined) {
      // The initial state and cursor must describe the same committed database state.
      return transaction(this.db, () => {
        const { cursor } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM state_log').get();
        const orders = this.db.prepare(`SELECT snapshot FROM orders ORDER BY json_extract(snapshot,'$.created_at')`)
          .all().map(row => JSON.parse(row.snapshot));
        return { cursor, orders };
      });
    }
    const changes = this.db.prepare(`SELECT state_log.id, orders.snapshot FROM state_log
      JOIN orders ON orders.id = state_log.order_id WHERE state_log.id > ?
      ORDER BY state_log.id LIMIT 200`).all(after);
    const snapshots = new Set(changes.map(row => row.snapshot));
    return { cursor: changes.at(-1)?.id ?? after, orders: [...snapshots].map(value => JSON.parse(value)) };
  }
  diagnostics() {
    return {
      pending_jobs: this.db.prepare("SELECT id,type,order_id,attempts,last_error FROM jobs WHERE status='PENDING'").all(),
      pending_events: this.db.prepare('SELECT event_id,destination,attempts,last_error FROM outbox WHERE delivered_at IS NULL').all(),
    };
  }
  findPendingJob(id) { return this.db.prepare("SELECT * FROM jobs WHERE id=? AND status='PENDING'").get(id); }
  dueJobs() { return this.db.prepare("SELECT * FROM jobs WHERE status='PENDING' AND next_attempt_at<=? ORDER BY created_at,id LIMIT 30").all(Date.now()); }
  finishJob(id) { this.db.prepare("UPDATE jobs SET status='DONE',finished_at=?,last_error=NULL WHERE id=?").run(now(), id); }
  retryJob(job, error) {
    const delay = Math.min(10000, 250 * 2 ** Math.min(job.attempts, 6));
    this.db.prepare('UPDATE jobs SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=?').run(Date.now() + delay, error.code || error.message, job.id);
  }
  pendingOutbox() { return this.db.prepare('SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY rowid LIMIT 60').all(Date.now()); }
  delivered(event) { this.db.prepare('UPDATE outbox SET delivered_at=?,last_error=NULL WHERE event_id=? AND destination=?').run(now(), event.event_id, event.destination); }
  retryEvent(event, error) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE event_id=? AND destination=?').run(Date.now() + Math.min(10000, 250 * 2 ** Math.min(event.attempts, 6)), error.code || error.message, event.event_id, event.destination);
  }
}
