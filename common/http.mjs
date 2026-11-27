import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { verify, verifyInternal } from './auth.mjs';
import { readBody, parseJsonObject } from './body.mjs';

import { AppError as HttpError } from './errors.mjs';
import { log } from './log.mjs';
export { HttpError, log };
const responseTag = Symbol('response');
export const response = (status, body) => ({ [responseTag]: true, status, body });
export function createServer({ service, routes, onClose }) {
  const compiled = routes.map(route => ({ ...route, parts: route.path.split('/').filter(Boolean) }));
  const server = http.createServer(async (req, res) => {
    const requestId = /^[\w-]{1,80}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : randomUUID();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Instance', process.env.INSTANCE_ID || `${service}-${process.pid}`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      let parts;
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new HttpError(400, 'INVALID_PATH', '请求路径无效'); }
      const route = compiled.find(r => r.method === req.method && r.parts.length === parts.length && r.parts.every((v, i) => v.startsWith(':') || v === parts[i]));
      if (!route) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const actor = verify(req.headers.authorization);
      if (route.role === 'INTERNAL') {
        if (!verifyInternal(req.headers['x-internal-token'])) throw new HttpError(401, 'UNAUTHORIZED', '内部调用认证失败');
      } else if (route.role && route.role !== 'PUBLIC') {
        if (!actor) throw new HttpError(401, 'UNAUTHORIZED', '请先选择账号登录');
        if (route.role !== 'ANY' && actor.role !== route.role) throw new HttpError(403, 'FORBIDDEN', '当前身份无权执行此操作');
      }
      const body = parseJsonObject(await readBody(req));
      const params = Object.fromEntries(route.parts.flatMap((v, i) => v.startsWith(':') ? [[v.slice(1), parts[i]]] : []));
      const result = await route.handler({ req, res, params, query: url.searchParams, body, actor, requestId });
      const status = result?.[responseTag] ? result.status : 200;
      const responseBody = result?.[responseTag] ? result.body : result ?? {};
      res.writeHead(status);
      res.end(JSON.stringify(responseBody));
      if (req.method !== 'GET') log(service, 'request', { request_id: requestId, method: req.method, path: url.pathname, status, order_id: responseBody.order?.id || body.order_id || body.aggregate_id || (service === 'order' ? params.id : undefined) });
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) {
        if (error.headers && typeof error.headers === 'object') {
          for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
        }
        res.writeHead(status);
      }
      res.end(JSON.stringify({ error: { code: error.code || 'INTERNAL_ERROR', message: status === 500 ? '服务暂时无法完成请求' : error.message, ...(error.details ? { details: error.details } : {}) }, request_id: requestId }));
      log(service, 'request_error', { request_id: requestId, method: req.method, path: req.url, status, code: error.code, message: error.message });
    }
  });
  if (onClose) server.on('close', onClose);
  return server;
}
export async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 1500, internal = true } = {}) {
  const auth = internal ? { 'X-Internal-Token': process.env.INTERNAL_TOKEN || 'lab3-local-internal' } : {};
  let result;
  try {
    result = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', '相关服务暂时不可用，系统将保留进度，请稍后重试', { cause: error.name });
  }
  let value;
  try { value = await result.json(); } catch { throw new HttpError(502, 'BAD_UPSTREAM_RESPONSE', '相关服务返回了无法识别的结果'); }
  if (!result.ok) throw new HttpError(result.status, value.error?.code || 'UPSTREAM_ERROR', value.error?.message || '相关服务未能完成操作', value.error?.details);
  return value;
}
