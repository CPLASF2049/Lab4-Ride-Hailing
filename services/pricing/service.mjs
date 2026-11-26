import { createServer, HttpError } from '../../common/http.mjs';
import { openDb, migrate, uid, now } from '../../common/db.mjs';

export const places = Object.freeze([
  { id: 'fudan', name: '复旦大学邯郸校区', lat: 31.2989, lng: 121.5033 },
  { id: 'shanghai-station', name: '上海站', lat: 31.2497, lng: 121.4558 },
  { id: 'bund', name: '外滩', lat: 31.2400, lng: 121.4900 },
  { id: 'people-square', name: '人民广场', lat: 31.2304, lng: 121.4737 },
  { id: 'hongqiao-station', name: '虹桥站', lat: 31.1957, lng: 121.3273 },
  { id: 'xujiahui', name: '徐家汇', lat: 31.1882, lng: 121.4365 },
].map(place => Object.freeze(place)));
export const fareRule = Object.freeze({ base_cents: 1200, per_km_cents: 250, included_m: 3000 });

export function estimatedDistance(origin, destination) {
  const radians = degrees => degrees * Math.PI / 180;
  const latDelta = radians(destination.lat - origin.lat);
  const lngDelta = radians(destination.lng - origin.lng);
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(origin.lat)) * Math.cos(radians(destination.lat)) * Math.sin(lngDelta / 2) ** 2;
  const straightLine = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.max(100, Math.round(straightLine * 1.3));
}

export function calculateFare(distanceM) {
  if (!Number.isInteger(distanceM) || distanceM <= 0 || distanceM > 200000) {
    throw new HttpError(400, 'INVALID_DISTANCE', '模拟里程须为1–200000米之间的整数');
  }
  return fareRule.base_cents + Math.round(Math.max(0, distanceM - fareRule.included_m) * fareRule.per_km_cents / 1000);
}

export function createPricing({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  migrate(db, `
    CREATE TABLE IF NOT EXISTS estimates (
      id TEXT PRIMARY KEY,
      rider_id TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      distance_m INTEGER NOT NULL,
      duration_s INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      rule_json TEXT NOT NULL
    );
  `);

  function getEstimate(id) {
    const row = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'ESTIMATE_NOT_FOUND', '预估报价不存在');
    return {
      id: row.id, rider_id: row.rider_id,
      origin: JSON.parse(row.origin_json), destination: JSON.parse(row.destination_json),
      distance_m: row.distance_m, duration_s: row.duration_s, amount_cents: row.amount_cents,
      created_at: row.created_at, expires_at: row.expires_at, rule: JSON.parse(row.rule_json),
      estimated: true, distance_method: 'haversine_x_1_3',
    };
  }

  const server = createServer({ service: 'pricing', routes: [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => {
      db.prepare('SELECT 1').get();
      return { service: 'pricing', status: 'ok' };
    } },
    { method: 'GET', path: '/places', role: 'PUBLIC', handler: () => ({ places }) },
    { method: 'POST', path: '/orders/estimate', role: 'RIDER', handler: ({ actor, body }) => {
      const origin = places.find(place => place.id === body?.origin_id);
      const destination = places.find(place => place.id === body?.destination_id);
      if (!origin || !destination) throw new HttpError(400, 'INVALID_PLACE', '请选择系统提供的上海预设地点');
      if (origin.id === destination.id) throw new HttpError(400, 'SAME_PLACE', '起点和终点不能相同');
      const distanceM = estimatedDistance(origin, destination);
      const id = uid('estimate');
      const createdAt = now();
      const expiresAt = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
      const durationS = Math.max(60, Math.round(distanceM / (30 * 1000 / 3600)));
      db.prepare(`INSERT INTO estimates
        (id,rider_id,origin_json,destination_json,distance_m,duration_s,amount_cents,created_at,expires_at,rule_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, actor.id, JSON.stringify(origin), JSON.stringify(destination), distanceM, durationS,
          calculateFare(distanceM), createdAt, expiresAt, JSON.stringify(fareRule));
      console.log(JSON.stringify({ service: 'pricing', order_id: null, action: 'estimated', estimate_id: id }));
      return { estimate: getEstimate(id) };
    } },
    // Expired quotes stay readable so Order can validate expiry and finish existing rides.
    { method: 'GET', path: '/internal/estimates/:id', role: 'INTERNAL', handler: ({ params }) => ({ estimate: getEstimate(params.id) }) },
    { method: 'POST', path: '/internal/fare', role: 'INTERNAL', handler: ({ body }) => {
      if (typeof body?.estimate_id !== 'string' || !body.estimate_id || body.estimate_id.length > 200) {
        throw new HttpError(400, 'INVALID_REQUEST', '请提供有效的预估报价标识');
      }
      const estimate = getEstimate(body.estimate_id);
      const amountCents = calculateFare(body.distance_m);
      return { distance_m: body.distance_m, amount_cents: amountCents, rule: estimate.rule };
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
