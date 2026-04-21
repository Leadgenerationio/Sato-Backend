import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { db } from '../config/database.js';
import { campaigns } from '../db/schema/campaigns.js';
import { syncAll } from '../integrations/leadbyte/leadbyte-client.js';
import { recordLeadByteSync } from '../controllers/integration.controller.js';
import { syncAll as catchrSyncAll } from '../services/ad-spend.service.js';
import { recordCatchrSync } from '../controllers/ad-spend.controller.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import type { ResendSendRequest } from '../integrations/resend/resend-types.js';
import { emailQueue } from './queue.js';
import * as invoiceService from '../services/invoice.service.js';
import type { AuthPayload } from '../types/index.js';

const connection = redis ?? undefined;

if (!connection) {
  logger.warn('Redis not configured — workers will not start');
  process.exit(0);
}

const SYSTEM_AUTH: AuthPayload = {
  userId: 'system',
  role: 'owner',
  email: 'system@stato.local',
  businessId: 'system',
};

// Email worker — dispatches on job.name
new Worker('email', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing email job');

  switch (job.name) {
    case 'send-email': {
      const req = job.data as ResendSendRequest;
      return sendEmail(req);
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown email job — ignoring');
      return { skipped: true };
  }
}, { connection });

// Invoice worker — dispatches on job.name
new Worker('invoice', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing invoice job');

  switch (job.name) {
    case 'chase-overdue-invoices': {
      const overdue = await invoiceService.getOverdueInvoices(SYSTEM_AUTH);
      let enqueued = 0;
      for (const inv of overdue) {
        if (!emailQueue) break;
        await emailQueue.add('send-email', {
          to: `billing+${inv.clientId}@stato.local`,
          subject: `Invoice ${inv.invoiceNumber} overdue`,
          html: `<p>Invoice ${inv.invoiceNumber} for ${inv.clientName} is ${inv.daysOverdue} days overdue (${inv.currency} ${inv.total}).</p>`,
        } satisfies ResendSendRequest);
        enqueued++;
      }
      logger.info({ overdue: overdue.length, enqueued }, 'chase-overdue-invoices complete');
      return { overdue: overdue.length, enqueued };
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown invoice job — ignoring');
      return { skipped: true };
  }
}, { connection });

// Sync worker — dispatches on job.name
new Worker('sync', async (job) => {
  logger.info({ jobId: job.id, name: job.name }, 'Processing sync job');

  switch (job.name) {
    case 'leadbyte-hourly-sync': {
      const result = await syncAll({ db, campaigns });
      recordLeadByteSync(result.finishedAt);
      return result;
    }
    case 'catchr-hourly-sync': {
      const result = await catchrSyncAll({ db });
      recordCatchrSync(result.finishedAt);
      return result;
    }
    default:
      logger.warn({ jobId: job.id, name: job.name }, 'Unknown sync job — ignoring');
      return { skipped: true };
  }
}, { connection });

logger.info('Workers started');
