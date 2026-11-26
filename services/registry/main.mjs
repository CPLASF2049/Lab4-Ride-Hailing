import { config } from '../../common/config.mjs';
import { log } from '../../common/http.mjs';
import { createRegistry } from './service.mjs';

const cfg = config('registry', 8500);
const service = createRegistry(cfg);
service.server.listen(cfg.port, cfg.host, () => log('registry', 'listening', { host: cfg.host, port: cfg.port }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await service.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
