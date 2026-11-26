import { config } from '../../common/config.mjs';
import { log } from '../../common/log.mjs';
import { registerInstance } from '../../common/registration.mjs';
import { createGateway } from './service.mjs';

const settings = config('gateway', 8083);
const gateway = createGateway(settings);
await new Promise((resolve, reject) => {
  gateway.server.once('error', reject);
  gateway.server.listen(settings.port, settings.host, resolve);
});
const registration = await registerInstance({
  registryUrl: settings.registryUrl, service: 'gateway', port: gateway.server.address().port,
  ...(settings.instanceAddress ? { address: settings.instanceAddress } : {}), internalToken: settings.internalToken,
});
log('gateway', 'listening', { host: settings.host, port: gateway.server.address().port, instance_id: registration.id });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await registration.stop();
  await gateway.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
