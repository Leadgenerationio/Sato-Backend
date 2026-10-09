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
    eval: async (script: string, _n: number, k: string, windowMs: string) => {
      if (script.includes('DECR')) { const e = live(k); if (e) e.v -= 1; return e ? e.v : 0; }
      const e = live(k) ?? { v: 0, exp: -1 };
      e.v += 1; data.set(k, e);
      if (e.v === 1 || e.exp === -1) e.exp = Date.now() + Number(windowMs);
      return [e.v, ttl(k)];
    },
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

  it('does not create a counter when decrementing an expired key', async () => {
    const client = fakeRedis();
    const store = new RedisRateLimitStore(client);
    await store.decrement('gone');
    expect(client._data.has('rl:gone')).toBe(false);
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

describe('RedisRateLimitStore while Redis is down', () => {
  const deadRedis = () => ({
    eval: async () => { throw new Error('connection refused'); },
    del: async () => { throw new Error('connection refused'); },
    get: async () => { throw new Error('connection refused'); },
    pttl: async () => { throw new Error('connection refused'); },
  }) as unknown as Redis;

  it('keeps counting per process, so the limit does not switch itself off', async () => {
    const store = new RedisRateLimitStore(deadRedis());
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('api-key:a')).totalHits).toBe(1);
    expect((await store.increment('api-key:a')).totalHits).toBe(2);
    expect((await store.increment('api-key:a')).totalHits).toBe(3);
    expect((await store.increment('api-key:b')).totalHits).toBe(1);
    await store.decrement('api-key:a');
    expect((await store.increment('api-key:a')).totalHits).toBe(3);
    await store.resetKey('api-key:a');
    expect((await store.increment('api-key:a')).totalHits).toBe(1);
  });

  it('starts a new window when the old one has passed', async () => {
    const store = new RedisRateLimitStore(deadRedis());
    store.init({ windowMs: 30 } as never);
    await store.increment('k'); await store.increment('k');
    await new Promise((r) => setTimeout(r, 60));
    expect((await store.increment('k')).totalHits).toBe(1);
  });

  it('a limiter on it still answers 429 past the limit', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: rateLimit } = await import('express-rate-limit');
    const store = new RedisRateLimitStore(deadRedis());
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 3, store, passOnStoreError: true, keyGenerator: () => 'k', standardHeaders: true, legacyHeaders: false }));
    app.get('/', (_req, res) => { res.json({ ok: true }); });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).get('/')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('after a failure it skips Redis for a cooldown, so a hung Redis does not cost every request its timeout', async () => {
    let calls = 0;
    const slow = { eval: async () => { calls++; throw new Error('timeout'); }, del: async () => undefined, get: async () => { calls++; throw new Error('timeout'); }, pttl: async () => 0 } as unknown as Redis;
    const store = new RedisRateLimitStore(slow);
    store.init({ windowMs: 60_000 } as never);
    for (let i = 0; i < 20; i++) await store.increment('k');
    expect(calls).toBe(1); // only the first call tried Redis
    expect((await store.increment('k')).totalHits).toBe(21);
  });

  it('get() answers from the local count while Redis is down instead of throwing', async () => {
    const store = new RedisRateLimitStore(deadRedis());
    store.init({ windowMs: 60_000 } as never);
    await store.increment('g'); await store.increment('g');
    expect((await store.get('g'))?.totalHits).toBe(2);
    expect(await store.get('never-seen')).toBeUndefined();
  });
});
