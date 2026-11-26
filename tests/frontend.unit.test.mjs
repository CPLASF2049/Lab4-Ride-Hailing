import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// These units exercise asynchronous browser state boundaries with an inert DOM.
// Actual layout, map fallback and click-through behavior are covered by browser-smoke.mjs.
const source = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
const bootIndex = source.lastIndexOf('\nvoid boot();');
assert.ok(bootIndex > 0, 'The browser startup must remain separate from its state functions');

class Element {
  constructor() {
    this.hidden = false; this.disabled = false; this.value = ''; this.open = false;
    this.innerHTML = ''; this.textContent = ''; this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  contains() { return false; }
  setAttribute() {}
  append() {}
  remove() {}
  focus() {}
  scrollIntoView() {}
  addEventListener() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
}
function harness(role = 'RIDER') {
  const elements = new Map();
  const document = {
    activeElement: null,
    querySelector(key) { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); },
    querySelectorAll: () => [], createElement: () => new Element(),
    getElementById: key => elements.get(`#${key}`), addEventListener() {},
  };
  const storage = new Map();
  let fetchHandler = async () => json({});
  const context = vm.createContext({
    document, console, crypto: webcrypto, Response, AbortSignal,
    fetch: (...args) => fetchHandler(...args),
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
    },
    // Timers are inert so unit cases never create a live polling loop.
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  });
  vm.runInContext(source.slice(0, bootIndex), context);
  const run = code => vm.runInContext(code, context);
  const state = run('state');
  state.actor = { id: role === 'DRIVER' ? 'driver-1' : 'rider-1', role, name: role === 'DRIVER' ? '王师傅' : '陈同学' };
  state.token = 'unit-token';
  return { state, context, run, document, storage, setFetch(handler) { fetchHandler = handler; } };
}
const point = { id: 'fudan', name: '复旦大学邯郸校区', lat: 31.2989, lng: 121.5033 };
function fixture() {
  const estimate = {
    id: 'est_1', distance_m: 7800, amount_cents: 2400, duration_s: 600,
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  const order = {
    id: 'ord_test', rider_id: 'rider-1', status: 'ACCEPTED', version: 6,
    origin: point, destination: { id: 'bund', name: '外滩', lat: 31.24, lng: 121.49 },
    estimate, driver_id: 'driver-1', offer_id: 'offer_1', created_at: new Date().toISOString(),
  };
  const offer = { id: 'offer_1', order_id: order.id, status: 'PENDING', expires_at: estimate.expires_at, origin: order.origin, destination: order.destination };
  return { estimate, order, offer };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('an older projection cannot roll back a successful mutation; equal version clears syncing', () => {
  const h = harness();
  h.context.order = fixture().order;
  h.run('applyMutation(order)');
  h.run("applyQuery({order:{...order,version:3,status:'MATCHING'},sync_pending:true}, order.id)");
  assert.equal(h.state.current.version, 6);
  assert.equal(h.state.current.status, 'ACCEPTED');
  assert.equal(h.state.syncPending, true);
  h.run('applyQuery({order,sync_pending:false}, order.id)');
  assert.equal(h.state.syncPending, false);
});

test('202 without a projected order keeps the authoritative order and shows syncing', () => {
  const h = harness();
  h.context.order = fixture().order;
  h.run('applyMutation(order)');
  h.run('applyQuery({order:null,sync_pending:true},order.id)');
  assert.equal(h.state.current.id, 'ord_test');
  assert.equal(h.state.current.version, 6);
  assert.equal(h.state.syncPending, true);
});

test('a stale current lookup for another order does not replace an active local order', () => {
  const h = harness();
  h.context.order = fixture().order;
  h.run('applyMutation(order)');
  h.run("applyQuery({order:{...order,id:'old_order',status:'CANCELLED',version:10}})");
  assert.equal(h.state.current.id, 'ord_test');
  assert.equal(h.state.current.status, 'ACCEPTED');
});

test('history never overwrites the current order with an older snapshot', async () => {
  const h = harness();
  const { order } = fixture();
  h.context.order = order;
  h.run('applyMutation(order)');
  h.setFetch(async () => json({ orders: [{ ...order, version: 2, status: 'MATCHING' }] }));
  await h.run('loadHistory()');
  assert.equal(h.state.current.version, 6);
  assert.equal(h.state.current.status, 'ACCEPTED');
  assert.equal(h.state.history[0].version, 6);
});

test('a lost creation response retains the same UUID idempotency key for retry', async () => {
  const h = harness();
  const { order, estimate } = fixture();
  h.state.estimate = estimate;
  const calls = [];
  h.setFetch(async (path, options) => { calls.push({ path, options }); throw new Error('response lost'); });
  await h.run('createRide()');
  const firstKey = h.state.pendingCreate.key;
  assert.match(firstKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  h.setFetch(async (path, options) => { calls.push({ path, options }); return json({ order: { ...order, status: 'MATCHING', version: 1, driver_id: null } }, 201); });
  await h.run('createRide()');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['Idempotency-Key'], firstKey);
  assert.equal(calls[1].options.headers['Idempotency-Key'], firstKey);
  assert.equal(h.state.pendingCreate, null);
  assert.equal(h.state.current.version, 1);
});

test('repeated create clicks while a request is pending issue only one request', async () => {
  const h = harness();
  const { order, estimate } = fixture();
  h.state.estimate = estimate;
  let release, calls = 0;
  h.setFetch(async () => { calls++; await new Promise(resolve => { release = resolve; }); return json({ order: { ...order, status: 'MATCHING' } }, 201); });
  const first = h.run('createRide()');
  await h.run('createRide()');
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(h.state.current.id, order.id);
});

test('HTTP 200 with MATCHING after a failed assignment is not treated as a driver current order', async () => {
  const h = harness('DRIVER');
  const { order, offer } = fixture();
  h.state.driver = { id: 'driver-1', online: true };
  h.state.offers = [offer];
  h.setFetch(async () => json({ order: { ...order, status: 'MATCHING', driver_id: null, last_assignment_failure: 'DRIVER_BUSY' } }));
  await h.run("respondOffer('accept','offer_1')");
  assert.equal(h.state.current, null);
  assert.equal(h.state.pendingAcceptance, null);
  assert.equal(h.state.offers.length, 0);
});

test('202 ASSIGNING retains a real pending order without enabling trip progression', async () => {
  const h = harness('DRIVER');
  const { order, offer } = fixture();
  h.state.driver = { id: 'driver-1', online: true };
  h.state.offers = [offer];
  h.setFetch(async () => json({ order: { ...order, status: 'ASSIGNING', driver_id: null, pending_driver_id: 'driver-1' } }, 202));
  await h.run("respondOffer('accept','offer_1')");
  assert.equal(h.state.current.status, 'ASSIGNING');
  assert.equal(h.state.syncPending, true);
  const html = h.document.querySelector('#driverCurrent').innerHTML;
  assert.match(html, /重新确认接单结果/);
  assert.doesNotMatch(html, /data-action="arrive"|data-action="start"|data-action="finish"/);
});

test('closing new offers while busy preserves the trip and still allows finishing with actual meters', async () => {
  const h = harness('DRIVER');
  const { order } = fixture();
  h.state.current = { ...order, status: 'IN_PROGRESS' };
  h.state.driver = { id: 'driver-1', online: true, active_order_id: order.id };
  h.setFetch(async () => json({ driver: { ...h.state.driver, online: false } }));
  await h.run('toggleOnline()');
  assert.equal(h.state.driver.online, false);
  assert.equal(h.state.current.status, 'IN_PROGRESS');
  h.document.querySelector('#finishDistance').value = '4.321';
  let meters;
  h.setFetch(async (path, options) => {
    meters = JSON.parse(options.body).distance_m;
    return json({ order: { ...order, status: 'COMPLETED', version: 7, final_distance_m: meters, final_amount_cents: 1530 } });
  });
  await h.run("mutateOrder('finish','ord_test')");
  assert.equal(meters, 4321);
  assert.equal(h.state.current.final_distance_m, 4321);
  assert.equal(h.state.current.final_amount_cents, 1530);
});

test('an invalid final distance never submits a finish request', async () => {
  const h = harness('DRIVER');
  h.state.current = { ...fixture().order, status: 'IN_PROGRESS' };
  h.document.querySelector('#finishDistance').value = '-1';
  let calls = 0;
  h.setFetch(async () => { calls++; return json({}); });
  await h.run("mutateOrder('finish','ord_test')");
  assert.equal(calls, 0);
  assert.equal(h.state.current.status, 'IN_PROGRESS');
});

function assignmentHarness() {
  const h = harness('DRIVER');
  const { order } = fixture();
  h.state.current = { ...order, status: 'ASSIGNING', driver_id: null, pending_driver_id: 'driver-1' };
  const controls = { activeOrderId: null, offers: [], offersFail: false, driverFail: false };
  h.setFetch(async path => {
    if (path.includes('/orders/')) return json({ error: { code: 'NOT_YOUR_ORDER', message: '只能查询自己的订单' } }, 403);
    if (path.endsWith('/offers')) {
      if (controls.offersFail) throw new Error('offers unavailable');
      return json({ offers: controls.offers });
    }
    if (controls.driverFail) throw new Error('driver unavailable');
    return json({ driver: { id: 'driver-1', online: true, active_order_id: controls.activeOrderId } });
  });
  return { ...h, controls };
}

test('an old projection 403 cannot clear a pending assignment while driver occupation exists', async () => {
  const h = assignmentHarness();
  h.controls.activeOrderId = 'ord_test';
  await h.run('poll()'); await h.run('poll()');
  assert.equal(h.state.current.status, 'ASSIGNING');
  assert.equal(h.state.syncPending, true);
});

test('a CLAIMED offer prevents premature clearing even before occupation is visible', async () => {
  const h = assignmentHarness();
  h.controls.offers = [{ ...fixture().offer, status: 'CLAIMED' }];
  await h.run('poll()'); await h.run('poll()');
  assert.equal(h.state.current.status, 'ASSIGNING');
  assert.equal(h.state.assignmentEmptyChecks, 0);
});

test('unavailable offer or driver data cannot be mistaken for a failed assignment', async () => {
  const h = assignmentHarness();
  h.controls.offersFail = true;
  await h.run('poll()'); await h.run('poll()');
  assert.equal(h.state.current.status, 'ASSIGNING');
  h.controls.offersFail = false; h.controls.driverFail = true;
  await h.run('poll()'); await h.run('poll()');
  assert.equal(h.state.current.status, 'ASSIGNING');
  assert.equal(h.state.assignmentEmptyChecks, 0);
});

test('two complete checks of no ownership, occupation or active offer recover a rejected assignment', async () => {
  const h = assignmentHarness();
  await h.run('poll()');
  assert.equal(h.state.current.status, 'ASSIGNING', 'a single mixed-time snapshot must not clear the result');
  await h.run('poll()');
  assert.equal(h.state.current, null);
  assert.equal(h.state.pendingAcceptance, null);
  assert.equal(h.state.syncPending, false);
});

test('polling never overlaps even if a scheduled or manual refresh fires during a request', async () => {
  const h = harness();
  h.run('historyLastFetched = Date.now()');
  let release, calls = 0;
  h.setFetch(async () => { calls++; await new Promise(resolve => { release = resolve; }); return json({ order: null }); });
  const first = h.run('poll()');
  await h.run('poll()');
  assert.equal(calls, 1);
  release(); await first;
});

test('a response arriving after logout cannot restore the previous actor or order', async () => {
  const h = harness();
  const { order } = fixture();
  h.state.current = order;
  h.run('saveSession()');
  let release;
  h.setFetch(async () => { await new Promise(resolve => { release = resolve; }); return json({ order: { ...order, status: 'CANCELLED', version: 7 } }); });
  const action = h.run("mutateOrder('cancel','ord_test')");
  h.run('logout()');
  release(); await action;
  assert.equal(h.state.actor, null);
  assert.equal(h.state.current, null);
  assert.equal(h.storage.has('huxing.session.v1'), false);
});

test('a slower estimate response cannot replace the quote for a newer selection', async () => {
  const h = harness();
  const { estimate } = fixture();
  h.state.originId = 'fudan'; h.state.destinationId = 'bund';
  const releases = new Map();
  h.setFetch(async (path, options) => {
    const destination = JSON.parse(options.body).destination_id;
    await new Promise(resolve => { releases.set(destination, resolve); });
    return json({ estimate: { ...estimate, id: `estimate_${destination}` } });
  });
  const older = h.run('requestEstimate()');
  h.state.destinationId = 'shanghai-station';
  const newer = h.run('requestEstimate()');
  releases.get('shanghai-station')(); await newer;
  releases.get('bund')(); await older;
  assert.equal(h.state.estimate.id, 'estimate_shanghai-station');
  assert.equal(h.state.estimateLoading, false);
});
