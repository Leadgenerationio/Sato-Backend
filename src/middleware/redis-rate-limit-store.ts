import type { Store, Options, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';
import type { Redis } from 'ioredis';

/**
 * express-rate-limit store on Redis, so a per-key limit holds across every
 * backend instance (the default MemoryStore counts per process, which
 * multiplies the limit by the number of instances).
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
    const k = this.prefix + key;
    const res = await this.client.multi().incr(k).pttl(k).exec();
    const totalHits = Number(res?.[0]?.[1] ?? 1);
    let ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.client.pexpire(k, this.windowMs);
      ttl = this.windowMs;
    }
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  async decrement(key: string): Promise<void> {
    await this.client.decr(this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const k = this.prefix + key;
    const [hits, ttl] = await Promise.all([this.client.get(k), this.client.pttl(k)]);
    if (hits === null) return undefined;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }
}
