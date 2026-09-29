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

/**
 * Queue a one-account Meta / Taboola creative sync ("Sync now"). Deduped per
 * account via jobId, so repeated clicks don't stack runs. Returns false when
 * Redis isn't configured (the caller then runs the sync inline).
 */
export async function enqueuePlatformSync(linkId: string): Promise<boolean> {
  if (!syncQueue) return false;
  await syncQueue.add('platform-creative-sync-account', { linkId }, {
    jobId: `platform-creative-sync-${linkId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
  return true;
}

// Creative library (0045): server-made thumbnails for images/videos.
export const mediaQueue = connection
  ? new Queue('media', { connection })
  : null;
