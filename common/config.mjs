import path from 'node:path';

export function config(name, defaultPort) {
  const port = Number(process.env.INSTANCE_PORT || process.env.PORT || defaultPort);
  return {
    port,
    host: process.env.HOST || '127.0.0.1',
    dbPath: process.env.DB_PATH || path.resolve('data', `${name}.sqlite`),
    registryUrl: process.env.REGISTRY_URL || '',
    serviceName: process.env.SERVICE_NAME || name,
    instanceAddress: process.env.INSTANCE_ADDRESS || '',
    internalToken: process.env.INTERNAL_TOKEN || 'lab3-local-internal',
    orderUrl: process.env.ORDER_URL || 'http://127.0.0.1:3101',
    queryUrl: process.env.QUERY_URL || 'http://127.0.0.1:3102',
    driverUrl: process.env.DRIVER_URL || 'http://127.0.0.1:3103',
    dispatchUrl: process.env.DISPATCH_URL || 'http://127.0.0.1:3104',
    pricingUrl: process.env.PRICING_URL || 'http://127.0.0.1:3105',
  };
}
