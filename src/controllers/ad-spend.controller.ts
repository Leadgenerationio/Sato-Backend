import type { Request, Response } from 'express';
import { syncQueue } from '../jobs/queue.js';
import { logger } from '../utils/logger.js';
import * as svc from '../services/ad-spend.service.js';
import { isCatchrConfigured } from '../integrations/catchr/index.js';

let lastCatchrSyncAt: string | null = null;
export function recordCatchrSync(ts: string): void {
  lastCatchrSyncAt = ts;
}
export function getLastCatchrSyncAt(): string | null {
  return lastCatchrSyncAt;
}

function filtersFromQuery(req: Request): svc.AdSpendFilters {
  const q = req.query;
  return {
    from: typeof q.from === 'string' ? q.from : undefined,
    to: typeof q.to === 'string' ? q.to : undefined,
    platform: typeof q.platform === 'string' ? q.platform : undefined,
    accountId: typeof q.accountId === 'string' ? q.accountId : undefined,
    clientId: typeof q.clientId === 'string' ? q.clientId : undefined,
    campaignSearch: typeof q.q === 'string' ? q.q : undefined,
    limit: typeof q.limit === 'string' ? parseInt(q.limit, 10) : undefined,
    offset: typeof q.offset === 'string' ? parseInt(q.offset, 10) : undefined,
  };
}

export async function status(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isCatchrConfigured(),
      lastSyncAt: lastCatchrSyncAt,
    },
  });
}

export async function list(req: Request, res: Response) {
  const rows = await svc.listAdSpend(filtersFromQuery(req));
  res.json({ status: 'success', data: rows });
}

export async function summary(req: Request, res: Response) {
  const rows = await svc.summarizeAdSpend(filtersFromQuery(req));
  const total = await svc.totalSpend(filtersFromQuery(req));
  res.json({ status: 'success', data: { rows, total } });
}

export async function syncNow(_req: Request, res: Response) {
  if (!syncQueue) {
    res.status(503).json({ status: 'error', message: 'Background queue not available (Redis not configured)' });
    return;
  }
  const job = await syncQueue.add('catchr-hourly-sync', { triggeredBy: 'manual' });
  logger.info({ jobId: job.id }, 'Manual Catchr sync enqueued');
  res.json({ status: 'success', data: { jobId: job.id, enqueuedAt: new Date().toISOString() } });
}
