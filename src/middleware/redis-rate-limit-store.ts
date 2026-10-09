import { logger } from '../utils/logger.js';
import type { Store, Options, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';
import type { Redis } from 'ioredis';

// INCR + expiry in one atomic step, so a crash between the two can never leave
// a counter without a TTL. A key found with no TTL (-1) is repaired too.
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local t = redis.call('PTTL', KEYS[1])
if c == 1 or t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {c, t}
`;

// Decrement only a live counter: a bare DECR on an expired key would create -1 with no TTL.
const DECR_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end
return 0
`;

/** Redis has this long to answer; past it the request is let through (see passOnStoreError). */
const REDIS_TIMEOUT_MS = 1000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis rate-limit store timed out')), REDIS_TIMEOUT_MS);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * express-rate-limit store on Redis, so a per-key limit holds across every
 * backend instance (the default MemoryStore counts per process, which
 * multiplies the limit by the number of instances). Errors and timeouts throw,
 * and the limiter is configured with passOnStoreError so Redis trouble never
 * takes the API down.
 */
export class RedisRateLimitStore implements Store {
  private windowMs = 60_000;
  /** Counters live in Redis, so every instance sees the same hits. */
  readonly localKeys = false;
  readonly prefix: string;
  /**
   * While Redis is down or too slow, calls are counted here instead (per process), so the limit still holds, at worst
   * multiplied by the number of instances, rather than switching itself off. Entries die with their window.
   */
  private readonly fallback = new Map<string, { hits: number; resetAt: number }>();
  private downSince: number | null = null;

  constructor(private readonly client: Redis, prefix = 'rl:') {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private localIncrement(key: string): IncrementResponse {
    const now = Date.now();
    if (this.fallback.size > 10_000) for (const [k, e] of this.fallback) if (e.resetAt <= now) this.fallback.delete(k);
    let e = this.fallback.get(key);
    if (!e || e.resetAt <= now) { e = { hits: 0, resetAt: now + this.windowMs }; this.fallback.set(key, e); }
    e.hits += 1;
    return { totalHits: e.hits, resetTime: new Date(e.resetAt) };
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      const res = await withTimeout(this.client.eval(INCR_SCRIPT, 1, this.prefix + key, String(this.windowMs))) as [number, number];
      if (!Array.isArray(res)) throw new Error('Unexpected Redis reply for rate-limit increment');
      this.downSince = null;
      return { totalHits: Number(res[0]), resetTime: new Date(Date.now() + Number(res[1])) };
    } catch (err) {
      if (this.downSince === null) {
        this.downSince = Date.now();
        logger.warn({ err: (err as Error).message }, 'Rate-limit Redis unavailable: counting per process until it is back');
      }
      return this.localIncrement(key);
    }
  }

  async decrement(key: string): Promise<void> {
    const e = this.fallback.get(key);
    if (e && e.hits > 0) e.hits -= 1;
    await withTimeout(this.client.eval(DECR_SCRIPT, 1, this.prefix + key)).catch(() => undefined);
  }

  async resetKey(key: string): Promise<void> {
    this.fallback.delete(key);
    await withTimeout(this.client.del(this.prefix + key)).catch(() => undefined);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const k = this.prefix + key;
    const [hits, ttl] = await withTimeout(Promise.all([this.client.get(k), this.client.pttl(k)]));
    if (hits === null) return undefined;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }
}
