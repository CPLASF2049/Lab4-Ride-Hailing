import { createHmac, timingSafeEqual } from 'node:crypto';

export const accounts = Object.freeze([
  { id: 'rider-1', role: 'RIDER', name: '陈同学' },
  { id: 'rider-2', role: 'RIDER', name: '李同学' },
  { id: 'driver-1', role: 'DRIVER', name: '王师傅' },
  { id: 'driver-2', role: 'DRIVER', name: '赵师傅' },
]);
function signature(payload) {
  return createHmac('sha256', process.env.AUTH_SECRET || 'lab3-demo-change-before-public-use').update(payload).digest('base64url');
}
function equal(a, b) {
  const aa = Buffer.from(a || ''); const bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function login(accountId) {
  const actor = accounts.find(a => a.id === accountId);
  if (!actor) throw Object.assign(new Error('请选择有效的演示账号'), { status: 400, code: 'UNKNOWN_ACCOUNT' });
  const payload = Buffer.from(JSON.stringify({ sub: actor.id, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return { token: `${payload}.${signature(payload)}`, actor };
}
export function verify(token) {
  try {
    const [payload, sig, extra] = (token || '').replace(/^Bearer\s+/i, '').split('.');
    if (extra || !payload || !equal(signature(payload), sig)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    return accounts.find(a => a.id === claims.sub) || null;
  } catch { return null; }
}
export const verifyInternal = token => equal(token, process.env.INTERNAL_TOKEN || 'lab3-local-internal');
