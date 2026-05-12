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

  // Slice 5 Day 4 — process recurring tasks every 5 min. The job picks up
  // any tasks where recurrence_next_run has passed and clones them.
  await syncQueue.upsertJobScheduler('recurring-tasks', {
    pattern: '*/5 * * * *',
  }, {
    name: 'recurring-tasks-tick',
    data: {},
  });

  // Pre-warm the LeadByte Redis cache every 90 seconds. Refreshes:
  //   - lb:campaigns                  (the campaign list)
  //   - lb:report:{today,week,month,ytd}:v5  (the 4 windows /campaigns reads)
  // Each prewarm cycle takes ~25s (4 sequential LeadByte calls) so we keep
  // the interval generous; the cache TTL is 5 min, so 90s gives 3+ refreshes
  // per TTL window — plenty of buffer if one cycle has a transient failure.
  await syncQueue.upsertJobScheduler('leadbyte-cache-prewarm', {
    every: 90_000,
  }, {
    name: 'leadbyte-cache-prewarm',
    data: {},
  });

  logger.info('Scheduled jobs registered');
}
