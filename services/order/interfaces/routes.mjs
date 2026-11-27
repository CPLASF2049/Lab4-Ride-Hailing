import { HttpError, response } from '../../../common/http.mjs';

export function orderRoutes(app, repo) {
  return [
    { method: 'GET', path: '/health', role: 'PUBLIC', handler: () => ({ status: 'ok', service: 'order', database: repo.health() ? 'ok' : 'error' }) },
    { method: 'POST', path: '/orders', role: 'RIDER', handler: async c => response(201, { order: await app.create(c.actor.id, c.body, c.req.headers['idempotency-key']) }) },
    { method: 'POST', path: '/orders/:id/cancel', role: 'RIDER', handler: c => ({ order: app.cancel(c.params.id, c.actor.id) }) },
    { method: 'POST', path: '/orders/:id/arrive', role: 'DRIVER', handler: c => ({ order: app.arrive(c.params.id, c.actor.id) }) },
    { method: 'POST', path: '/orders/:id/start', role: 'DRIVER', handler: c => ({ order: app.start(c.params.id, c.actor.id) }) },
    { method: 'POST', path: '/orders/:id/finish', role: 'DRIVER', handler: async c => ({ order: await app.finish(c.params.id, c.actor.id, c.body) }) },
    { method: 'GET', path: '/internal/orders/snapshots', role: 'INTERNAL', handler: c => {
      const value = c.query.get('after');
      if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        throw new HttpError(400, 'INVALID_CURSOR', '快照游标须为非负安全整数');
      }
      return { generated_at: new Date().toISOString(), ...repo.snapshots(value === null ? undefined : Number(value)) };
    } },
    { method: 'GET', path: '/internal/orders/:id', role: 'INTERNAL', handler: c => ({ order: repo.get(c.params.id) }) },
    { method: 'POST', path: '/internal/orders/:id/accept', role: 'INTERNAL', handler: async c => {
      const order = await app.accept(c.params.id, c.body);
      return response(order.status === 'ASSIGNING' ? 202 : 200, { order });
    } },
    { method: 'POST', path: '/internal/orders/:id/fail-matching', role: 'INTERNAL', handler: c => ({ order: app.failMatching(c.params.id, c.body.reason) }) },
    { method: 'GET', path: '/internal/diagnostics', role: 'INTERNAL', handler: () => repo.diagnostics() },
  ];
}
