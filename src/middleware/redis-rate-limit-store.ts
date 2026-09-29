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

  constructor(private readonly client: Redis, prefix = 'rl:') {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const res = await withTimeout(this.client.eval(INCR_SCRIPT, 1, this.prefix + key, String(this.windowMs))) as [number, number];
    if (!Array.isArray(res)) throw new Error('Unexpected Redis reply for rate-limit increment');
    return { totalHits: Number(res[0]), resetTime: new Date(Date.now() + Number(res[1])) };
  }

  async decrement(key: string): Promise<void> {
    await withTimeout(this.client.decr(this.prefix + key));
  }

  async resetKey(key: string): Promise<void> {
    await withTimeout(this.client.del(this.prefix + key));
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const k = this.prefix + key;
    const [hits, ttl] = await withTimeout(Promise.all([this.client.get(k), this.client.pttl(k)]));
    if (hits === null) return undefined;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }
}
