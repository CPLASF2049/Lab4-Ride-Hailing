/** Fault-tolerance primitives shared by order-query's dependency calls. */

export class TokenBucket {
  constructor({ capacity = 30, refillPerSecond = 15 } = {}) {
    this.capacity = capacity; this.refillPerSecond = refillPerSecond; this.tokens = capacity; this.updatedAt = Date.now();
  }
  refill(nowMs = Date.now()) {
    const gained = ((nowMs - this.updatedAt) / 1000) * this.refillPerSecond;
    if (gained > 0) { this.tokens = Math.min(this.capacity, this.tokens + gained); this.updatedAt = nowMs; }
  }
  take(cost = 1) {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost; return true;
  }
  snapshot() { this.refill(); return { capacity: this.capacity, tokens: Math.floor(this.tokens * 100) / 100, refill_per_second: this.refillPerSecond }; }
}

export class RateLimiter {
  constructor(options = {}) { this.options = { capacity: 20, refillPerSecond: 10, ...options }; this.buckets = new Map(); this.rejected = 0; }
  /** Returns true when the request may proceed; key is normally the actor id or IP. */
  take(key, nowMs = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = new TokenBucket(this.options); this.buckets.set(key, bucket); }
    const allowed = bucket.take();
    if (!allowed) this.rejected++;
    if (this.buckets.size > 5000) { for (const [candidate, value] of this.buckets) { value.refill(nowMs); if (value.tokens === value.capacity) this.buckets.delete(candidate); } }
    return allowed;
  }
  snapshot() { return { buckets: this.buckets.size, rejected: this.rejected, ...this.options }; }
}

export class CircuitBreaker {
  constructor({ failureThreshold = 5, windowMs = 10000, openMs = 8000, halfOpenProbes = 1, name = 'dependency' } = {}) {
    Object.assign(this, { failureThreshold, windowMs, openMs, halfOpenProbes, name });
    this.state = 'CLOSED'; this.failures = []; this.openedAt = 0; this.probes = 0;
    this.counters = { success: 0, failure: 0, rejected: 0, opened: 0, half_open: 0, closed: 0 };
  }
  allow(nowMs = Date.now()) {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (nowMs - this.openedAt >= this.openMs) { this.state = 'HALF_OPEN'; this.probes = 0; this.counters.half_open++; return true; }
      this.counters.rejected++; return false;
    }
    if (this.probes < this.halfOpenProbes) { this.probes++; return true; }
    this.counters.rejected++; return false;
  }
  success() {
    this.counters.success++;
    if (this.state === 'HALF_OPEN') { this.state = 'CLOSED'; this.failures = []; this.counters.closed++; }
    else if (this.state === 'CLOSED') this.failures = [];
  }
  failure(nowMs = Date.now()) {
    this.counters.failure++;
    if (this.state === 'HALF_OPEN') { this.trip(nowMs); return; }
    if (this.state !== 'CLOSED') return;
    this.failures.push(nowMs);
    this.failures = this.failures.filter(time => nowMs - time <= this.windowMs);
    if (this.failures.length >= this.failureThreshold) this.trip(nowMs);
  }
  trip(nowMs) { this.state = 'OPEN'; this.openedAt = nowMs; this.failures = []; this.counters.opened++; }
  snapshot() {
    return { name: this.name, state: this.state, failures_in_window: this.failures.length, counters: { ...this.counters }, failure_threshold: this.failureThreshold, window_ms: this.windowMs, open_ms: this.openMs };
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Retry only transient failures; never retry a definitive 4xx business rejection. */
export async function withRetry(operation, { attempts = 2, backoffMs = 120, shouldRetry = error => !error.status || error.status >= 500, onAttempt } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      onAttempt?.(error, attempt);
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}
