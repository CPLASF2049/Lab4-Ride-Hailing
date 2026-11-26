import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const dataRoot = path.resolve(root, process.env.DATA_DIR || 'data');
const relative = path.relative(root, dataRoot);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reset only supports a data directory strictly inside this repository.');
if (!process.argv.includes('--yes')) {
  console.log(`将重置 ${dataRoot} 内五个业务数据库。请先停止服务，再运行 node scripts/reset.mjs --yes。`);
  process.exitCode = 1;
} else {
  const names = ['order','query','driver','dispatch','pricing'];
  const running = await Promise.all(names.map(async (name, i) => {
    try { return (await fetch(`http://127.0.0.1:${process.env[`${name.toUpperCase()}_PORT`] || 3101 + i}/health`, { signal: AbortSignal.timeout(500) })).ok ? name : null; }
    catch { return null; }
  }));
  if (running.some(Boolean)) throw new Error(`请先停止服务：${running.filter(Boolean).join(', ')}`);
  for (const name of names) for (const suffix of ['', '-wal', '-shm']) {
    const target = path.resolve(dataRoot, `${name}.sqlite${suffix}`);
    if (path.dirname(target) !== dataRoot) throw new Error('Unexpected reset target');
    if (existsSync(target)) { console.log(`重置：${target}`); unlinkSync(target); }
  }
  console.log('数据库已重置。下次启动将创建空订单和两名离线司机；四个演示身份始终可选。');
}
