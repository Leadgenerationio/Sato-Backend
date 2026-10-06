import { Request, Response } from 'express';
import * as service from '../services/ad-account-links.service.js';
import * as platformSync from '../services/platform-creative-sync.service.js';
import { enqueuePlatformSync } from '../jobs/queue.js';

export async function list(req: Request, res: Response) {
  const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
  const data = await service.listAdAccounts(req.user!, Number.isFinite(days) ? days : 30, {
    platform: req.query.platform ? String(req.query.platform) : undefined,
    clientId: req.query.clientId ? String(req.query.clientId) : undefined,
    campaignId: req.query.campaignId ? String(req.query.campaignId) : undefined,
    linked: req.query.linked === undefined ? undefined : req.query.linked === 'true',
    q: req.query.q ? String(req.query.q) : undefined,
  });
  // The bulk-link screen edits this list and re-reads it straight after a
  // save. The global 'private, max-age=5, stale-while-revalidate=30' on API
  // GETs (src/index.ts) made the browser answer that re-read from its HTTP
  // cache, so the screen kept showing the pre-save figures.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
}

export async function bulkLink(req: Request, res: Response) {
  const data = await service.bulkUpsertLinks(req.user!, req.body.links);
  res.json({ status: 'success', data });
}

export async function lookup(req: Request, res: Response) {
  const data = await service.lookupClientByAdAccount(
    req.user!,
    String(req.query.platform),
    String(req.query.accountId),
  );
  res.json({ status: 'success', data });
}

// ─── Phase 3: scheduled Meta / Taboola creative sync ───

export async function syncStatus(req: Request, res: Response) {
  const data = await platformSync.getSyncStatus(req.user!);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
}

export async function syncNow(req: Request, res: Response) {
  const data = await platformSync.requestSyncNow(req.user!, String(req.params.id), enqueuePlatformSync);
  res.status(data.queued ? 202 : 200).json({ status: 'success', data });
}

/** POST /clients/:id/ad-accounts — one link, for the public API. */
export async function linkOne(req: Request, res: Response) {
  const { platform, accountId, campaignId, accountName, currency } = req.body as {
    platform: string; accountId: string; campaignId?: string | null; accountName?: string | null; currency?: string | null;
  };
  const data = await service.bulkUpsertLinks(req.user!, [{ platform, accountId, clientId: String(req.params.id), campaignId, accountName, currency }]);
  const action = data.results[0]?.action ?? 'unchanged';
  res.status(action === 'created' ? 201 : 200).json({ status: 'success', data: { link: data.results[0] ?? null } });
}
