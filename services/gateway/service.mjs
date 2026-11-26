import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { accounts, login, verify } from '../../common/auth.mjs';
import { Discovery } from '../../common/discovery.mjs';
import { RateLimiter } from '../../common/resilience.mjs';
import { log } from '../../common/log.mjs';

const FRONTEND_DIR = fileURLToPath(new URL('../../frontend/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/vendor/leaflet/leaflet.js', ['vendor/leaflet/leaflet.js', 'text/javascript; charset=utf-8']],
  ['/vendor/leaflet/leaflet.css', ['vendor/leaflet/leaflet.css', 'text/css; charset=utf-8']],
  ['/vendor/leaflet/LICENSE', ['vendor/leaflet/LICENSE', 'text/plain; charset=utf-8']],
]);

// Public allowlist. Names here are registry service names; internal routes are never exposed.
const ROUTES = [
  ['GET', /^\/places$/, 'pricing', 'PUBLIC'],
  ['POST', /^\/orders\/estimate$/, 'pricing', 'RIDER'],
  ['POST', /^\/orders$/, 'order', 'RIDER'],
  ['GET', /^\/orders\/history$/, 'order-query', 'RIDER'],
  ['GET', /^\/orders\/current$/, 'order-query', 'ANY'],
  ['GET', /^\/orders\/[A-Za-z0-9_-]{1,160}$/, 'order-query', 'ANY'],
  ['POST', /^\/orders\/[A-Za-z0-9_-]{1,160}\/(cancel)$/, 'order', 'RIDER'],
  ['POST', /^\/orders\/[A-Za-z0-9_-]{1,160}\/(arrive|start|finish)$/, 'order', 'DRIVER'],
  ['GET', /^\/drivers\/me$/, 'driver', 'DRIVER'],
  ['PUT', /^\/drivers\/me\/status$/, 'driver', 'DRIVER'],
  ['GET', /^\/drivers\/me\/offers$/, 'dispatch', 'DRIVER'],
  ['POST', /^\/offers\/[A-Za-z0-9_-]{1,160}\/(accept|reject)$/, 'dispatch', 'DRIVER'],
];

function json(res, status, body, requestId, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw fail(413, 'BODY_TOO_LARGE', '请求内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function authorize(req, role) {
  if (role === 'PUBLIC') return;
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) throw fail(401, 'UNAUTHORIZED', '请先选择账号登录');
  const actor = verify(match[1]);
  if (!actor) throw fail(401, 'UNAUTHORIZED', '登录已失效，请重新登录');
  if (role !== 'ANY' && String(actor.role).toUpperCase() !== role) {
    throw fail(403, 'FORBIDDEN', '当前身份无法执行此操作');
  }
}

const safeAccount = account => ({ id: account.id, role: account.role, name: account.name });

/** Create an unbound gateway. The caller owns server.listen(). */
export function createGateway(options = {}) {
  const frontendDir = resolve(options.frontendDir || FRONTEND_DIR);
  const staticUrls = {
    order: options.orderUrl,
    'order-query': options.queryUrl,
    driver: options.driverUrl,
    dispatch: options.dispatchUrl,
    pricing: options.pricingUrl,
  };
  const discovery = options.discovery || new Discovery({
    registryUrl: options.registryUrl || '',
    staticUrls: Object.fromEntries(Object.entries(staticUrls).filter(([, url]) => url)),
  });
  const timeoutMs = options.timeoutMs ?? 5000;
  const limiter = options.limiter || new RateLimiter({ capacity: Number(options.rateCapacity ?? 80), refillPerSecond: Number(options.rateRefill ?? 40) });
  const cursors = new Map();

  async function listOrdered(service) {
    const instances = await discovery.list(service);
    if (!instances.length) return [];
    const start = (cursors.get(service) || 0) % instances.length;
    cursors.set(service, start + 1);
    return [...instances.slice(start), ...instances.slice(0, start)];
  }

  async function proxy(service, businessPath, search, req, headers, body) {
    const instances = await listOrdered(service);
    if (!instances.length) throw fail(503, 'NO_INSTANCE', `服务 ${service} 当前没有可用实例`);
    // Reads fail over to another replica; writes stay on one target to avoid duplicate side effects.
    const targets = ['GET', 'HEAD'].includes(req.method) ? instances : instances.slice(0, 1);
    let lastError;
    for (let attempt = 0; attempt < targets.length; attempt++) {
      const instance = targets[attempt];
      try {
        const upstream = await fetch(new URL(`${businessPath}${search}`, instance.url), {
          method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        });
        if (attempt > 0) log('gateway', 'instance_failover', { service, instance: instance.id, attempt: attempt + 1 });
        return { upstream, instance };
      } catch (error) {
        lastError = error;
        log('gateway', 'instance_unreachable', { service, instance: instance.id, code: error.name });
      }
    }
    const timedOut = lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError';
    throw fail(timedOut ? 504 : 502, timedOut ? 'UPSTREAM_TIMEOUT' : 'SERVICE_UNAVAILABLE',
      timedOut ? '请求确认超时，请稍后刷新查看结果' : '服务暂时无法连接，请稍后重试');
  }

  const server = createServer(async (req, res) => {
    const suppliedId = req.headers['x-request-id'];
    const requestId = typeof suppliedId === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(suppliedId)
      ? suppliedId : randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Request-Id', requestId);
    try {
      const rawPath = String(req.url || '/').split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); }
      catch { throw fail(400, 'INVALID_PATH', '请求路径无效'); }
      if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded)
          || decoded.split('/').some((part) => part === '.' || part === '..')) {
        throw fail(400, 'INVALID_PATH', '请求路径无效');
      }
      const url = new URL(req.url, 'http://gateway.local');
      const path = url.pathname;

      if (path === '/health' && req.method === 'GET') {
        return json(res, 200, { service: 'gateway', status: 'ok', instance_id: process.env.INSTANCE_ID || null }, requestId);
      }
      if (path === '/api/auth/accounts' && req.method === 'GET') {
        return json(res, 200, { accounts: accounts.map(safeAccount) }, requestId);
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { throw fail(400, 'INVALID_JSON', '请提交有效的 JSON 请求'); }
        if (!body || typeof body.account_id !== 'string') {
          throw fail(400, 'INVALID_ACCOUNT', '请选择有效的账号');
        }
        return json(res, 200, await login(body.account_id), requestId);
      }
      if (path === '/api/system/health' && req.method === 'GET') {
        const services = await Promise.all(['order', 'order-query', 'driver', 'dispatch', 'pricing'].map(async (name) => {
          const instances = await discovery.list(name);
          const checks = await Promise.all(instances.map(async instance => {
            try {
              const response = await fetch(`${instance.url}/health`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
              const body = await response.json().catch(() => ({}));
              return { instance: instance.id, healthy: response.ok, ...(body.bootstrap_state ? { bootstrap_state: body.bootstrap_state } : {}) };
            } catch { return { instance: instance.id, healthy: false }; }
          }));
          return [name, { healthy: checks.some(check => check.healthy), instances: instances.length, checks }];
        }));
        return json(res, 200, { services: Object.fromEntries(services), discovery: discovery.snapshot() }, requestId);
      }
      if (path === '/api/system/discovery' && req.method === 'GET') {
        const services = await Promise.all(['order', 'order-query', 'driver', 'dispatch', 'pricing'].map(async name => [name, (await discovery.list(name)).map(instance => instance.id)]));
        return json(res, 200, { services: Object.fromEntries(services), generated_at: new Date().toISOString() }, requestId);
      }

      if (path.startsWith('/api/')) {
        const businessPath = path.slice(4);
        const route = ROUTES.find(([method, pattern]) => method === req.method && pattern.test(businessPath));
        if (!route) {
          const knownPath = ROUTES.some(([, pattern]) => pattern.test(businessPath));
          throw fail(knownPath ? 405 : 404, knownPath ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
            knownPath ? '此接口不支持该操作' : '接口不存在');
        }
        const [, , service, role] = route;
        authorize(req, role);
        if (!limiter.take(req.socket.remoteAddress || 'unknown')) {
          throw Object.assign(fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'), { retryAfter: true });
        }
        const headers = { Accept: 'application/json', 'X-Request-Id': requestId };
        if (req.headers.authorization) headers.Authorization = req.headers.authorization;
        if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];
        let body;
        if (!['GET', 'HEAD'].includes(req.method)) {
          body = await readBody(req);
          headers['Content-Type'] = 'application/json';
          if (body.length) {
            try { JSON.parse(body.toString('utf8')); }
            catch { throw fail(400, 'INVALID_JSON', '请提交有效的 JSON 请求'); }
          }
        }
        const { upstream, instance } = await proxy(service, businessPath, url.search, req, headers, body);
        const result = await upstream.text();
        if (result.length) {
          try { JSON.parse(result); }
          catch { throw fail(502, 'INVALID_UPSTREAM_RESPONSE', '服务暂时无法返回结果，请稍后重试'); }
        }
        const responseHeaders = {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Request-Id': upstream.headers.get('x-request-id') || requestId,
          'X-Instance': upstream.headers.get('x-instance') || instance.id,
          'X-Gateway': 'lab4-gateway',
        };
        if (upstream.headers.get('retry-after')) responseHeaders['Retry-After'] = upstream.headers.get('retry-after');
        if (upstream.status === 429) responseHeaders['X-RateLimit-Scope'] = 'gateway-or-upstream';
        res.writeHead(upstream.status, responseHeaders);
        return res.end(result);
      }

      const asset = ASSETS.get(path);
      if (!asset) throw fail(404, 'NOT_FOUND', '页面不存在');
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'METHOD_NOT_ALLOWED', '此页面不支持该操作');
      const [relativePath, contentType] = asset;
      let contents;
      try { contents = await readFile(resolve(frontendDir, relativePath)); }
      catch (error) {
        if (error.code === 'ENOENT') throw fail(404, 'NOT_FOUND', '页面资源不存在');
        throw error;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': contents.byteLength,
        'Cache-Control': path.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = Number(error.status || error.statusCode) || 500;
      const known = status >= 400 && status < 600;
      const body = { error: {
        code: error.code || 'INTERNAL_ERROR',
        message: known && status < 500 ? error.message : (error.code ? error.message : '服务暂时不可用，请稍后重试'),
        ...(error.details && status < 500 ? { details: error.details } : {}),
      }, request_id: requestId };
      json(res, known ? status : 500, body, requestId, error.retryAfter ? { 'Retry-After': '1' } : {});
      if (status >= 500 || !known) log('gateway', 'request_error', { request_id: requestId, path: req.url, status, code: error.code });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server, discovery, limiter,
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}
