import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisRateLimitStore } from '../middleware/redis-rate-limit-store.js';

// Minimal in-memory stand-in for the ioredis calls the store makes. eval()
// mirrors the Lua script: INCR, and set the expiry when the key is new or has none.
function fakeRedis() {
  const data = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => { const e = data.get(k); if (e && e.exp !== -1 && e.exp <= Date.now()) { data.delete(k); return undefined; } return e; };
  const ttl = (k: string) => { const e = live(k); return !e ? -2 : e.exp === -1 ? -1 : e.exp - Date.now(); };
  const client = {
    eval: async (_script: string, _n: number, k: string, windowMs: string) => {
      const e = live(k) ?? { v: 0, exp: -1 };
      e.v += 1; data.set(k, e);
      if (e.v === 1 || e.exp === -1) e.exp = Date.now() + Number(windowMs);
      return [e.v, ttl(k)];
    },
    decr: async (k: string) => { const e = live(k); if (e) e.v -= 1; },
    del: async (k: string) => { data.delete(k); },
    get: async (k: string) => { const e = live(k); return e ? String(e.v) : null; },
    pttl: async (k: string) => ttl(k),
    _data: data,
  };
  return client as unknown as Redis & { _data: typeof data };
}

describe('RedisRateLimitStore', () => {
  it('repairs a counter that lost its TTL instead of blocking forever', async () => {
    const client = fakeRedis();
    client._data.set('rl:k', { v: 500, exp: -1 });
    const store = new RedisRateLimitStore(client);
    store.init({ windowMs: 60_000 } as never);
    await store.increment('k');
    expect(client._data.get('rl:k')!.exp).toBeGreaterThan(Date.now());
  });

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
