import { config } from '../../common/config.mjs';
import { runService } from '../../common/run-service.mjs';
import { createOrder } from './service.mjs';

const cfg = config('order', 3101);
await runService({ service: 'order', cfg, factory: createOrder, afterListen: app => app.startWorkers() });
