import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';

/**
 * Periodically refreshes the LeadByte caches the dashboard depends on,
 * BEFORE their TTL expires. This is what eliminates the "first user pays
 * the cold-cache cost" problem — by the time anyone clicks anywhere,
 * Redis is always warm.
 *
 * Strategy: bypass the read-through `cached()` wrapper and write fresh
 * results to Redis directly. Always overwrites with a fresh 60s TTL,
 * so even if the previous user warmed it 10 seconds ago, this call
 * extends the freshness window to a full 60s again.
 *
 * Run cadence: every 45s (handled by the BullMQ scheduler). 45 < 60s
 * TTL means the cache is always within 45s of being fully refreshed,
 * and the next prewarm fires before TTL expiry → users never see a
 * cold miss as long as the worker is healthy.
 *
 * Cost: ~9 LeadByte calls per run for ~8 campaigns = ~12k calls/day,
 * well within typical rate limits. If LeadByte starts rate-limiting,
 * gate this on "any user activity in the last 5 minutes" — see
 * `lastActivityAt` flag pattern in the docstring of warmLeadByteCache.
 */
const CACHE_TTL_SECONDS = 60;

export async function prewarmLeadByteCache(): Promise<{
  campaignsCached: number;
  deliveriesCached: number;
  durationMs: number;
}> {
  const start = Date.now();

  if (!redis) {
    logger.warn('Cache prewarm skipped — Redis not available');
    return { campaignsCached: 0, deliveriesCached: 0, durationMs: 0 };
  }

  // Direct LeadByte fetch — bypasses the `cached()` wrapper since we want
  // to FORCE a refresh, not a read-through.
  const campaigns = await leadbyte.getCampaigns();

  // Write the campaign list with a fresh TTL.
  await redis.set('lb:campaigns', JSON.stringify(campaigns), 'EX', CACHE_TTL_SECONDS);

  // Refresh each campaign's delivery report cache in parallel. Errors on
  // individual campaigns shouldn't block the others.
  const deliveryResults = await Promise.allSettled(
    campaigns.map(async (c) => {
      const deliveries = await leadbyte.getDeliveryReports(c.id, 30);
      await redis!.set(
        `lb:deliveries:${c.id}:30d`,
        JSON.stringify(deliveries),
        'EX',
        CACHE_TTL_SECONDS,
      );
      return c.id;
    }),
  );

  const deliveriesCached = deliveryResults.filter((r) => r.status === 'fulfilled').length;
  const failures = deliveryResults
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  if (failures.length > 0) {
    logger.warn({ failures: failures.length, total: campaigns.length }, 'Cache prewarm: some delivery refreshes failed');
  }

  const durationMs = Date.now() - start;
  logger.info(
    { campaignsCached: campaigns.length, deliveriesCached, durationMs },
    'Cache prewarm complete',
  );

  return { campaignsCached: campaigns.length, deliveriesCached, durationMs };
}
