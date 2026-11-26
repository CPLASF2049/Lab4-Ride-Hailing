import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const processFile = path.join(root, '.runtime', 'processes.json');
const launched = existsSync(processFile) ? JSON.parse(readFileSync(processFile, 'utf8')) : { services: [] };
const services = await Promise.all(['order','query','driver','dispatch','pricing','gateway'].map(async (name, i) => {
  const recorded = launched.services.find(s => s.name === name);
  const port = Number(process.env[`${name.toUpperCase()}_PORT`] || (name === 'gateway' ? 8083 : 3101 + i));
  let processAlive = false;
  if (recorded?.pid) { try { process.kill(recorded.pid, 0); processAlive = true; } catch {} }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return { name, port, pid: recorded?.pid || null, process_alive: processAlive, healthy: response.ok, health: await response.json() };
  } catch (error) { return { name, port, pid: recorded?.pid || null, process_alive: processAlive, healthy: false, error: error.name }; }
}));
let recovery;
try {
  const orderPort = process.env.ORDER_PORT || 3101;
  const r = await fetch(`http://127.0.0.1:${orderPort}/internal/diagnostics`, { headers: { 'X-Internal-Token': process.env.INTERNAL_TOKEN || 'lab3-local-internal' }, signal: AbortSignal.timeout(1500) });
  recovery = r.ok ? await r.json() : { status: r.status };
} catch { recovery = { unavailable: true }; }
const report = { captured_at: new Date().toISOString(), node: process.version, independent_business_services: services.filter(s => s.name !== 'gateway' && s.healthy && s.process_alive).length, services, recovery };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--save')) {
  mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'evidence', 'runtime.json'), JSON.stringify(report, null, 2));
}
if (services.some(s => !s.healthy)) process.exitCode = 1;
