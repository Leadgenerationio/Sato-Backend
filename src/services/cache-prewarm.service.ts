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
// Match campaign.service.ts CACHE_LIST_TTL_SECONDS. Prewarm overwrites with
// fresh TTL each run; user requests do the same on miss. Worst case (worker
// dies and no users hit for 5 min): one slow request, then back to fast.
const CACHE_TTL_SECONDS = 300;

export async function prewarmLeadByteCache(): Promise<{
  campaignsCached: number;
  reportsCached: number;
  durationMs: number;
}> {
  const start = Date.now();

  if (!redis) {
    logger.warn('Cache prewarm skipped — Redis not available');
    return { campaignsCached: 0, reportsCached: 0, durationMs: 0 };
  }

  // Refresh the campaign LIST first — used by listCampaigns directly.
  const campaigns = await leadbyte.getCampaigns();
  if (campaigns.length > 0) {
    await redis.set('lb:campaigns', JSON.stringify(campaigns), 'EX', CACHE_TTL_SECONDS);
  }

  // Refresh the four /reports/campaign windows that listCampaigns reads.
  // Sequential to avoid the burst-rate-limit pattern that caused some
  // windows to come back empty earlier. Empty results are NOT written
  // (matches the cache-helper guard) so a transient blip doesn't pin
  // zeros until the next prewarm.
  const windows: Array<{ key: string; w: 'today' | 'this_week' | 'this_month' | 'ytd' }> = [
    { key: 'lb:report:today:v5', w: 'today' },
    { key: 'lb:report:week:v5', w: 'this_week' },
    { key: 'lb:report:month:v5', w: 'this_month' },
    { key: 'lb:report:ytd:v5', w: 'ytd' },
  ];

  let reportsCached = 0;
  for (const { key, w } of windows) {
    try {
      const rows = await leadbyte.getCampaignReport(w);
      if (rows.length > 0) {
        await redis.set(key, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS);
        reportsCached++;
      } else {
        logger.warn({ key, window: w }, 'Cache prewarm: report came back empty — skip cache write');
      }
    } catch (err) {
      logger.warn({ err, key, window: w }, 'Cache prewarm: report fetch failed — skip');
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    { campaignsCached: campaigns.length, reportsCached, durationMs },
    'Cache prewarm complete',
  );

  return { campaignsCached: campaigns.length, reportsCached, durationMs };
}
