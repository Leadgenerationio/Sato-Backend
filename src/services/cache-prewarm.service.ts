import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import { recordLeadByteSync } from '../controllers/integration.controller.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';

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

// All 7 windows the LeadByte Dashboard exposes via the window selector.
// Keys must match what `leadbyte.routes.ts` reads through `cached()`.
const REPORT_WINDOWS: DeliveryWindow[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'ytd',
];

export async function prewarmLeadByteCache(): Promise<{
  campaignsCached: number;
  reportsCached: number;
  supplierSpendCached: number;
  buyersCached: boolean;
  deliveriesCached: boolean;
  durationMs: number;
}> {
  const start = Date.now();

  if (!redis) {
    logger.warn('Cache prewarm skipped — Redis not available');
    return {
      campaignsCached: 0,
      reportsCached: 0,
      supplierSpendCached: 0,
      buyersCached: false,
      deliveriesCached: false,
      durationMs: 0,
    };
  }

  // Refresh the campaign LIST first — used by listCampaigns directly.
  const campaigns = await leadbyte.getCampaigns();
  if (campaigns.length > 0) {
    await redis.set('lb:campaigns', JSON.stringify(campaigns), 'EX', CACHE_TTL_SECONDS);
  }

  // Refresh /reports/campaign for all 7 windows. Sequential to avoid the
  // burst-rate-limit pattern that caused some windows to come back empty.
  // Empty results are NOT written (matches the cache-helper guard) so a
  // transient blip doesn't pin zeros until the next prewarm.
  let reportsCached = 0;
  for (const w of REPORT_WINDOWS) {
    const key = `lb:report:${w}:v5`;
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

  // /reports/supplier-spend per window — drives the dashboard's spend table.
  let supplierSpendCached = 0;
  for (const w of REPORT_WINDOWS) {
    const key = `lb:supplier-spend:${w}:v1`;
    try {
      const rows = await leadbyte.getSupplierSpend(w);
      if (rows.length > 0) {
        await redis.set(key, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS);
        supplierSpendCached++;
      }
    } catch (err) {
      logger.warn({ err, key, window: w }, 'Cache prewarm: supplier-spend fetch failed — skip');
    }
  }

  // Buyers + deliveries listings (LeadByte → Buyers / Deliveries pages).
  let buyersCached = false;
  try {
    const buyers = await leadbyte.getBuyers();
    if (buyers.length > 0) {
      await redis.set('lb:buyers:all:v1', JSON.stringify(buyers), 'EX', CACHE_TTL_SECONDS);
      buyersCached = true;
    }
  } catch (err) {
    logger.warn({ err }, 'Cache prewarm: buyers fetch failed — skip');
  }

  let deliveriesCached = false;
  try {
    const deliveries = await leadbyte.getDeliveries();
    if (deliveries.length > 0) {
      await redis.set('lb:deliveries:all:v1', JSON.stringify(deliveries), 'EX', CACHE_TTL_SECONDS);
      deliveriesCached = true;
    }
  } catch (err) {
    logger.warn({ err }, 'Cache prewarm: deliveries fetch failed — skip');
  }

  // Mark a successful sync timestamp so the Settings → Integrations LeadByte
  // tile shows "Last sync: a few minutes ago" even if the slower 2-min sync
  // job hasn't run / has failed.
  recordLeadByteSync(new Date().toISOString());

  const durationMs = Date.now() - start;
  logger.info(
    {
      campaignsCached: campaigns.length,
      reportsCached,
      supplierSpendCached,
      buyersCached,
      deliveriesCached,
      durationMs,
    },
    'Cache prewarm complete',
  );

  return {
    campaignsCached: campaigns.length,
    reportsCached,
    supplierSpendCached,
    buyersCached,
    deliveriesCached,
    durationMs,
  };
}
