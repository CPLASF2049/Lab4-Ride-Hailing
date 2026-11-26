import { registerInstance } from './registration.mjs';
import { log } from './log.mjs';

/** Boot a business service, announce it in the registry, and clean up on signals. */
export async function runService({ service, cfg, factory, afterListen }) {
  const app = factory(cfg);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(cfg.port, cfg.host, resolve);
  });
  const registration = await registerInstance({
    registryUrl: cfg.registryUrl,
    service: cfg.serviceName || service,
    port: app.server.address().port,
    ...(cfg.instanceAddress ? { address: cfg.instanceAddress } : {}),
    internalToken: cfg.internalToken,
  });
  log(service, 'listening', { host: cfg.host, port: app.server.address().port, instance_id: registration.id });
  afterListen?.(app, registration);
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    await registration.stop();
    await app.close();
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { app, registration, stop };
}
