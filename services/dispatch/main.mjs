import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../../common/config.mjs';
import { runService } from '../../common/run-service.mjs';
import { createDispatch } from './service.mjs';

export { createDispatch } from './service.mjs';

export function main() {
  const cfg = config('dispatch', 3104);
  return runService({ service: 'dispatch', cfg, factory: createDispatch, afterListen: app => app.startWorkers() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
