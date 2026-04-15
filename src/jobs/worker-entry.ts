import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

const connection = redis ?? undefined;

if (!connection) {
  logger.warn('Redis not configured — workers will not start');
  process.exit(0);
}

// Email worker
new Worker('email', async (job) => {
  logger.info({ jobId: job.id, data: job.data }, 'Processing email job');
  // TODO: implement email sending
}, { connection });

// Invoice worker
new Worker('invoice', async (job) => {
  logger.info({ jobId: job.id, data: job.data }, 'Processing invoice job');
  // TODO: implement invoice processing
}, { connection });

// Sync worker
new Worker('sync', async (job) => {
  logger.info({ jobId: job.id, data: job.data }, 'Processing sync job');
  // TODO: implement sync logic
}, { connection });

logger.info('Workers started');
