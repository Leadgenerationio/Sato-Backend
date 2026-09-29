import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisRateLimitStore } from '../middleware/redis-rate-limit-store.js';

// Minimal in-memory stand-in for the ioredis calls the store makes.
function fakeRedis() {
  const data = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => { const e = data.get(k); if (e && e.exp !== -1 && e.exp <= Date.now()) { data.delete(k); return undefined; } return e; };
  const client = {
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        incr(k: string) { ops.push(() => { const e = live(k) ?? { v: 0, exp: -1 }; e.v += 1; data.set(k, e); return e.v; }); return chain; },
        pttl(k: string) { ops.push(() => { const e = live(k); return !e ? -2 : e.exp === -1 ? -1 : e.exp - Date.now(); }); return chain; },
        exec: async () => ops.map((f) => [null, f()]),
      };
      return chain;
    },
    pexpire: async (k: string, ms: number) => { const e = live(k); if (e) e.exp = Date.now() + ms; },
    decr: async (k: string) => { const e = live(k); if (e) e.v -= 1; },
    del: async (k: string) => { data.delete(k); },
    get: async (k: string) => { const e = live(k); return e ? String(e.v) : null; },
    pttl: async (k: string) => { const e = live(k); return !e ? -2 : e.exp === -1 ? -1 : e.exp - Date.now(); },
  };
  return client as unknown as Redis;
}

describe('RedisRateLimitStore', () => {
  it('counts hits and sets a window expiry on first hit', async () => {
    const store = new RedisRateLimitStore(fakeRedis());
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('api-key:a')).totalHits).toBe(1);
    const second = await store.increment('api-key:a');
    expect(second.totalHits).toBe(2);
    expect(second.resetTime!.getTime()).toBeGreaterThan(Date.now());
    expect((await store.increment('api-key:b')).totalHits).toBe(1);
  });

  it('two store instances on one client share the count (multi-instance)', async () => {
    const client = fakeRedis();
    const a = new RedisRateLimitStore(client); const b = new RedisRateLimitStore(client);
    a.init({ windowMs: 60_000 } as never); b.init({ windowMs: 60_000 } as never);
    await a.increment('k'); await b.increment('k');
    expect((await a.increment('k')).totalHits).toBe(3);
  });

  it('decrement and resetKey', async () => {
    const store = new RedisRateLimitStore(fakeRedis());
    store.init({ windowMs: 60_000 } as never);
    await store.increment('k'); await store.increment('k');
    await store.decrement('k');
    expect((await store.get('k'))?.totalHits).toBe(1);
    await store.resetKey('k');
    expect(await store.get('k')).toBeUndefined();
  });
});
