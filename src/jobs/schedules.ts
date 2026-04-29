import { invoiceQueue, syncQueue } from './queue.js';
import { logger } from '../utils/logger.js';

export async function registerSchedules() {
  if (!invoiceQueue || !syncQueue) {
    logger.warn('Redis not configured — skipping scheduled jobs');
    return;
  }

  // Chase overdue invoices daily at 9am
  await invoiceQueue.upsertJobScheduler('chase-overdue', {
    pattern: '0 9 * * *',
  }, {
    name: 'chase-overdue-invoices',
    data: {},
  });

  // Sync LeadByte data every 2 minutes for near-live reporting.
  // (1 min is aggressive against LeadByte rate limits; 2 min is Sam's
  // "every minute or so" with headroom.)
  await syncQueue.upsertJobScheduler('leadbyte-sync', {
    pattern: '*/2 * * * *',
  }, {
    name: 'leadbyte-hourly-sync',
    data: {},
  });

  // Sync Catchr ad-spend hourly (5 min offset from LeadByte to avoid spiking)
  await syncQueue.upsertJobScheduler('catchr-sync', {
    pattern: '5 * * * *',
  }, {
    name: 'catchr-hourly-sync',
    data: {},
  });

  // Sync Xero bank-feed hourly (10 min offset from Catchr).
  // Pulls last 90 days each run and upserts (idempotent).
  await syncQueue.upsertJobScheduler('bank-feed-sync', {
    pattern: '10 * * * *',
  }, {
    name: 'bank-feed-hourly-sync',
    data: {},
  });

  // Pre-warm the LeadByte Redis cache every 45 seconds. The dashboard's
  // /campaigns endpoint reads from this cache; without prewarming, the
  // first user after a 60s idle pays the full LeadByte cost (~1.5-2s).
  // 45s < 60s TTL, so the cache is always fresh by the time TTL would
  // expire. Cron patterns can't go below 1-minute granularity, so we use
  // the BullMQ `every: ms` form instead.
  await syncQueue.upsertJobScheduler('leadbyte-cache-prewarm', {
    every: 45_000,
  }, {
    name: 'leadbyte-cache-prewarm',
    data: {},
  });

  logger.info('Scheduled jobs registered');
}
