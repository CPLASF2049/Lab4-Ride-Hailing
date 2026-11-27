import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../common/http.mjs';
import { listen } from './helpers.mjs';

async function fixture(t) {
  const server = createServer({ service: 'http-test', routes: [
    { method: 'POST', path: '/echo', role: 'PUBLIC', handler: c => c.body },
    { method: 'GET', path: '/items/:id', role: 'PUBLIC', handler: c => c.params },
  ] });
  const base = await listen({ server });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return base;
}

function send(base, path, chunks = [], method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, agent: false }, res => {
      const received = [];
      res.on('data', chunk => received.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(received).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP boundary test timed out')));
    void (async () => {
      for (const chunk of chunks) { req.write(chunk); await delay(20); }
      req.end();
    })().catch(reject);
  });
}

test('HTTP: UTF-8 characters split between TCP chunks survive JSON parsing', async t => {
  const base = await fixture(t);
  const body = Buffer.from(JSON.stringify({ name: '上海叫车🚕' }));
  const split = body.indexOf(Buffer.from('上')) + 1;
  const result = await send(base, '/echo', [body.subarray(0, split), body.subarray(split)]);
  assert.equal(result.status, 200);
  assert.equal(result.body.name, '上海叫车🚕');
});

test('HTTP: oversized streaming bodies return a JSON 413 instead of resetting the connection', async t => {
  const base = await fixture(t);
  const result = await send(base, '/echo', [Buffer.alloc(32768, 32), Buffer.alloc(32769, 32)]);
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'BODY_TOO_LARGE');
});

test('HTTP: malformed percent encoding is a client error', async t => {
  const base = await fixture(t);
  const result = await send(base, '/items/%E0%A4%A', [], 'GET');
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_PATH');
});

test('HTTP: invalid UTF-8 and non-object JSON are rejected', async t => {
  const base = await fixture(t);
  const invalid = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.equal((await send(base, '/echo', [invalid])).status, 400);
  for (const value of ['null', '[]', '1', '"text"']) {
    const result = await send(base, '/echo', [Buffer.from(value)]);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_BODY');
  }
});
