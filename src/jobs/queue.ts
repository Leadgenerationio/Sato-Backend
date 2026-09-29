import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

const connection = redis ?? undefined;

export const emailQueue = connection
  ? new Queue('email', { connection })
  : null;

export const invoiceQueue = connection
  ? new Queue('invoice', { connection })
  : null;

export const syncQueue = connection
  ? new Queue('sync', { connection })
  : null;

export const workflowQueue = connection
  ? new Queue('workflow', { connection })
  : null;

// Plan phase 4: outbound webhook deliveries (src/services/webhook.service.ts).
export const webhookQueue = connection
  ? new Queue('webhook', { connection })
  : null;
