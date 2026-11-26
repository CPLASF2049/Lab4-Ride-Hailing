import { spawn } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

// folder name differs from registry name for order-query.
const specs = [
  { name: 'registry', folder: 'registry', port: 8500, service: 'registry' },
  { name: 'order', folder: 'order', port: 3101, service: 'order' },
  { name: 'query', folder: 'query', port: 3102, service: 'order-query' },
  { name: 'driver', folder: 'driver', port: 3103, service: 'driver' },
  { name: 'dispatch', folder: 'dispatch', port: 3104, service: 'dispatch' },
  { name: 'pricing', folder: 'pricing', port: 3105, service: 'pricing' },
  { name: 'gateway', folder: 'gateway', port: 8083, service: 'gateway' },
];
const ports = Object.fromEntries(specs.map(({ name, port }) => [name, Number(process.env[`${name.toUpperCase()}_PORT`] || port)]));
const host = process.env.HOST || '127.0.0.1';
const dataDirectory = path.resolve(process.env.DATA_DIR || 'data');
const registryUrl = `http://127.0.0.1:${ports.registry}`;

for (const { name } of specs) {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new Error(`${name} 端口 ${ports[name]} 已被占用或不可监听（${error.code}）。请先停止之前的启动组。`)));
    probe.listen(ports[name], host, () => probe.close(resolve));
  });
}
const children = [];
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  for (const { child } of children) if (!child.killed) child.kill('SIGTERM');
}
for (const { name, folder, service } of specs) {
  const child = spawn(process.execPath, [path.join(root, 'services', folder, 'main.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: {
      ...process.env,
      HOST: host, PORT: String(ports[name]), INSTANCE_PORT: String(ports[name]),
      SERVICE_NAME: service, INSTANCE_ADDRESS: '127.0.0.1', REGISTRY_URL: registryUrl,
      DB_PATH: path.join(dataDirectory, `${name}.sqlite`),
    },
  });
  children.push({ name, child });
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(); process.exitCode = 1; });
  child.on('exit', code => { if (!stopping && code !== 0) { console.error(`${name} exited (${code}); stopping this launch group.`); stop(); process.exitCode = 1; } });
}
mkdirSync(path.join(root, '.runtime'), { recursive: true });
writeFileSync(path.join(root, '.runtime', 'processes.json'), JSON.stringify({
  started_at: new Date().toISOString(), supervisor_pid: process.pid, registry: registryUrl,
  services: children.map(({ name, child }) => ({ name, pid: child.pid, port: ports[name] })),
}, null, 2));
console.log(`沪行 Lab4 已启动：注册中心 ${registryUrl}、5 个业务进程、网关。浏览器：http://localhost:${ports.gateway} ；Ctrl+C 停止，数据保留。`);
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('exit', stop);
