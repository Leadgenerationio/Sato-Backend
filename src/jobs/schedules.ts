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

  logger.info('Scheduled jobs registered');
}
