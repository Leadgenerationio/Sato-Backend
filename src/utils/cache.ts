import { redis } from '../config/redis.js';
import { logger } from './logger.js';

/**
 * How long we wait on a Redis op before bailing to a direct fetch. Keeping
 * this aggressive — Redis is in-region; if it doesn't respond within 200ms
 * something is wrong and the user shouldn't pay for our retry storm.
 */
const REDIS_OP_TIMEOUT_MS = 200;

function isRedisReady(): boolean {
  // ioredis reports 'ready' once a connection + handshake completes.
  // Any other status (connecting, reconnecting, end, disconnecting) means
  // calls would queue and potentially hang under maxRetriesPerRequest:null.
  return !!redis && redis.status === 'ready';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`redis op exceeded ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Read-through Redis cache. If Redis is unavailable, mid-reconnect, or slow,
 * falls through to `fn()` directly so callers always get a result. JSON-encoded.
 *
 * Use for read-mostly data where ~minute-old freshness is acceptable
 * (LeadByte aggregates, campaign metadata, etc). For real-time data
 * (auth tokens, money movements) bypass this and hit the source.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isRedisReady()) return fn();

  try {
    const hit = await withTimeout(redis!.get(key), REDIS_OP_TIMEOUT_MS);
    if (hit !== null) {
      return JSON.parse(hit) as T;
    }
  } catch (err) {
    logger.warn({ err, key }, 'Redis cache read failed/slow — bypassing');
  }

  const fresh = await fn();

  // Fire-and-forget the set so a slow Redis write never delays the response.
  if (isRedisReady()) {
    withTimeout(redis!.set(key, JSON.stringify(fresh), 'EX', ttlSeconds), REDIS_OP_TIMEOUT_MS)
      .catch((err) => logger.warn({ err, key }, 'Redis cache write failed/slow'));
  }

  return fresh;
}

/**
 * Invalidate one or more keys. Safe no-op when Redis is unavailable.
 */
export async function invalidateCache(...keys: string[]): Promise<void> {
  if (!isRedisReady() || keys.length === 0) return;
  try {
    await withTimeout(redis!.del(...keys), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err, keys }, 'Redis cache invalidation failed');
  }
}
