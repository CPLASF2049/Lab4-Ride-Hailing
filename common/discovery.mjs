import { AppError } from './errors.mjs';

const normalise = url => (url || '').replace(/\/$/, '');

/**
 * Resolves service names to live instances through the registry, with a short
 * cache and static URL fallback for component tests and single-process runs.
 */
export class Discovery {
  constructor({ registryUrl = '', internalToken, staticUrls = {}, ttlMs = 1500, timeoutMs = 700 } = {}) {
    this.registryUrl = normalise(registryUrl);
    this.internalToken = internalToken || process.env.INTERNAL_TOKEN || 'lab3-local-internal';
    this.staticUrls = staticUrls;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.cursor = new Map();
    this.stats = { registry_lookups: 0, cache_hits: 0, fallback_static: 0, no_instance: 0, failovers: 0 };
  }

  async list(service) {
    const cached = this.cache.get(service);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      this.stats.cache_hits++;
      return cached.instances;
    }
    if (!this.registryUrl) return this.staticList(service);
    this.stats.registry_lookups++;
    try {
      const response = await fetch(`${this.registryUrl}/v1/catalog/${encodeURIComponent(service)}`, {
        headers: { 'X-Internal-Token': this.internalToken }, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
      const body = await response.json();
      const instances = (body.instances || []).map(instance => ({
        ...instance, url: `http://${instance.address}:${instance.port}`,
      }));
      this.cache.set(service, { at: Date.now(), instances });
      return instances;
    } catch (error) {
      if (cached?.instances.length) return cached.instances;
      return this.staticList(service);
    }
  }

  staticList(service) {
    const url = this.staticUrls[service];
    if (!url) return [];
    this.stats.fallback_static++;
    const parsed = new URL(normalise(url));
    return [{ id: `static-${service}`, address: parsed.hostname, port: Number(parsed.port || 80), url: normalise(url) }];
  }

  async one(service) {
    const instances = await this.list(service);
    if (!instances.length) {
      this.stats.no_instance++;
      throw new AppError(503, 'NO_INSTANCE', `服务 ${service} 当前没有可用实例`);
    }
    const index = (this.cursor.get(service) || 0) % instances.length;
    this.cursor.set(service, index + 1);
    return instances[index];
  }

  async request(service, path, { method = 'GET', body, headers = {}, timeoutMs = 2000, retry = method === 'GET', instanceUrl } = {}) {
    const all = await this.list(service);
    const instances = instanceUrl ? [{ id: instanceUrl, url: instanceUrl }] : all;
    if (!instances.length) {
      this.stats.no_instance++;
      throw new AppError(503, 'NO_INSTANCE', `服务 ${service} 当前没有可用实例`);
    }
    const start = this.cursor.get(service) || 0;
    const attempts = retry ? instances.length : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const instance = instances[instanceUrl ? 0 : (start + attempt) % instances.length];
      try {
        const response = await fetch(`${instance.url}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.internalToken, ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {
          throw new AppError(502, 'BAD_UPSTREAM_RESPONSE', `服务 ${service} 返回了无法识别的结果`);
        }
        if (!response.ok) {
          const error = new AppError(response.status, data.error?.code || 'UPSTREAM_ERROR', data.error?.message || `服务 ${service} 请求失败`, data.error?.details);
          error.retryable = response.status >= 500;
          throw error;
        }
        this.cursor.set(service, (start + attempt + 1) % instances.length);
        return { data, instance };
      } catch (error) {
        lastError = error;
        if (error.status && !(retry && error.retryable)) throw error;
        if (attempt + 1 < attempts) this.stats.failovers++;
      }
    }
    if (lastError instanceof AppError) throw lastError;
    throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', `服务 ${service} 暂时不可用，请稍后重试`, { cause: lastError?.name });
  }

  snapshot() {
    return { registry: this.registryUrl || 'static', cache: Object.fromEntries([...this.cache].map(([name, value]) => [name, { instances: value.instances.length, age_ms: Date.now() - value.at }])), ...this.stats };
  }
}
