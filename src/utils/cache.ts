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

  // Don't cache empty results. We had a recurring bug where a transient empty
  // response (LeadByte returning [] under brief rate-limiting / cold-start)
  // got cached with the long TTL, blanking the dashboard for 5+ minutes
  // even though the next live call would have returned real data. Forcing
  // a re-fetch on empty is safer than trusting a one-shot empty.
  const looksEmpty =
    fresh === null ||
    fresh === undefined ||
    (Array.isArray(fresh) && fresh.length === 0) ||
    (typeof fresh === 'object' && fresh !== null && !Array.isArray(fresh) && Object.keys(fresh).length === 0);

  if (!looksEmpty && isRedisReady()) {
    // Fire-and-forget the set so a slow Redis write never delays the response.
    withTimeout(redis!.set(key, JSON.stringify(fresh), 'EX', ttlSeconds), REDIS_OP_TIMEOUT_MS)
      .catch((err) => logger.warn({ err, key }, 'Redis cache write failed/slow'));
  } else if (looksEmpty) {
    logger.info({ key }, 'Cache skip: result was empty — letting next call retry');
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
