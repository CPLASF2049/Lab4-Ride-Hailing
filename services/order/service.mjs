import { openDb } from '../../common/db.mjs';
import { config } from '../../common/config.mjs';
import { createServer, log } from '../../common/http.mjs';
import { AppError } from '../../common/errors.mjs';
import { Discovery } from '../../common/discovery.mjs';
import { OrderRepository } from './infrastructure/repository.mjs';
import { OrderApplication } from './application/order-service.mjs';
import { orderRoutes } from './interfaces/routes.mjs';

export function createOrder(options = {}) {
  const cfg = { ...config('order', 3101), ...options };
  const db = openDb(cfg.dbPath);
  const repository = new OrderRepository(db, ['query', 'dispatch']);
  const discovery = options.discovery || new Discovery({
    registryUrl: cfg.registryUrl, staticUrls: {
      pricing: cfg.pricingUrl, driver: cfg.driverUrl, dispatch: cfg.dispatchUrl,
      'order-query': cfg.queryUrl, order: cfg.orderUrl,
    },
  });
  const call = (service, path, settings = {}) => discovery.request(service, path, { timeoutMs: 1800, ...settings }).then(result => result.data);
  const clients = options.clients || {
    getEstimate: id => call('pricing', `/internal/estimates/${encodeURIComponent(id)}`),
    getOffer: id => call('dispatch', `/internal/offers/${encodeURIComponent(id)}`),
    claimOffer: p => call('dispatch', `/internal/offers/${encodeURIComponent(p.offer_id)}/claim`, { method: 'POST', body: p, retry: false }),
    reserveDriver: p => call('driver', `/internal/drivers/${encodeURIComponent(p.driver_id)}/reserve`, { method: 'POST', body: p, retry: false }),
    releaseDriver: p => call('driver', `/internal/drivers/${encodeURIComponent(p.driver_id)}/release`, { method: 'POST', body: p, retry: false }),
    resolveOffer: p => call('dispatch', `/internal/offers/${encodeURIComponent(p.offer_id)}/resolve`, { method: 'POST', body: p, retry: false }),
    calculateFare: p => call('pricing', '/internal/fare', { method: 'POST', body: p, retry: false }),
    // Fan-out: every order-query replica keeps its own read model, so each must
    // receive every event. Duplicates are absorbed by each replica's inbox.
    publish: async (destination, event) => {
      const service = destination === 'query' ? 'order-query' : 'dispatch';
      const instances = await discovery.list(service);
      if (!instances.length) throw new AppError(503, 'NO_INSTANCE', `事件目标 ${service} 当前没有可用实例`);
      const outcomes = await Promise.allSettled(instances.map(instance => call(service, '/internal/events', { method: 'POST', body: event, retry: false, timeoutMs: 1500, instanceUrl: instance.url })));
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
  const app = new OrderApplication({ repository, clients, clock: options.clock });
  const server = createServer({ service: 'order', routes: orderRoutes(app, repository) });
  let timer; let ticking = false; let closing = false; let currentTick = Promise.resolve();
  async function tick() {
    if (ticking || closing) return;
    ticking = true;
    currentTick = (async () => {
      await Promise.all(repository.dueJobs().map(job => app.runJob(job.id)));
      await Promise.all(repository.pendingOutbox().map(async event => {
        try {
          await clients.publish(event.destination, JSON.parse(event.payload)); repository.delivered(event);
        } catch (error) {
          repository.retryEvent(event, error);
          log('order', 'outbox_retry', { order_id: JSON.parse(event.payload).aggregate_id, event_id: event.event_id, destination: event.destination, attempt: event.attempts + 1, code: error.code || error.message });
        }
      }));
    })();
    try { await currentTick; } finally { ticking = false; }
  }
  function startWorkers() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(e => log('order', 'worker_error', { message: e.message })); }, options.tickMs || 250);
    void tick();
  }
  async function close() {
    closing = true; clearInterval(timer); await currentTick;
    if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    db.close();
  }
  return { server, db, repository, app, discovery, tick, startWorkers, close };
}
