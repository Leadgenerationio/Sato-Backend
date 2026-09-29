import { Request, Response } from 'express';
import * as service from '../services/ad-account-links.service.js';

export async function list(req: Request, res: Response) {
  const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
  const data = await service.listAdAccounts(req.user!, Number.isFinite(days) ? days : 30);
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
