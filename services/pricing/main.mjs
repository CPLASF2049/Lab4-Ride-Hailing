import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../../common/config.mjs';
import { runService } from '../../common/run-service.mjs';
import { createPricing } from './service.mjs';

export { createPricing } from './service.mjs';

export function main() {
  const cfg = config('pricing', 3105);
  return runService({ service: 'pricing', cfg, factory: createPricing });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
