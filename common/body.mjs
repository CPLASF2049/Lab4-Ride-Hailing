import { AppError } from './errors.mjs';

const MAX_BODY_BYTES = 64 * 1024;

export async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  // Keep the socket usable for the JSON error response when the limit is exceeded.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      req.resume();
      throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJsonObject(raw, { allowEmpty = true } = {}) {
  if (!raw.length && allowEmpty) return {};
  let body;
  try {
    // Decode only after joining bytes. A TCP chunk can end in the middle of a character.
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new AppError(400, 'INVALID_JSON', '请求内容须为有效的 UTF-8 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_BODY', '请求内容须为 JSON 对象');
  }
  return body;
}
