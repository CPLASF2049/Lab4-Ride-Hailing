import { config } from '../../common/config.mjs';
import { runService } from '../../common/run-service.mjs';
import { createQuery } from './service.mjs';

const cfg = config('order-query', 3102);
await runService({ service: 'order-query', cfg, factory: createQuery, afterListen: app => app.start() });
