import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../../common/config.mjs';
import { runService } from '../../common/run-service.mjs';
import { createDriver } from './service.mjs';

export { createDriver } from './service.mjs';

export function main() {
  const cfg = config('driver', 3103);
  return runService({ service: 'driver', cfg, factory: createDriver });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
