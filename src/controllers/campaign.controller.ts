import { Request, Response } from 'express';
import * as campaignService from '../services/campaign.service.js';
import * as trafficSourceService from '../services/traffic-source.service.js';

export async function listCampaigns(req: Request, res: Response) {
  const campaigns = await campaignService.listCampaigns(req.user!);

  // Optional query filters
  let filtered = campaigns;
  const { status, vertical, search, type } = req.query;

  if (status && status !== 'all') {
    filtered = filtered.filter((c) => c.status === status);
  }
  if (type && type !== 'all') {
    filtered = filtered.filter((c) => c.campaignType === type);
  }
  if (vertical) {
    filtered = filtered.filter((c) => c.vertical.toLowerCase() === (vertical as string).toLowerCase());
  }
  if (search) {
    const q = (search as string).toLowerCase();
    filtered = filtered.filter((c) =>
      c.name.toLowerCase().includes(q) || c.clientName.toLowerCase().includes(q),
    );
  }

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const total = filtered.length;
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit);

  res.json({ status: 'success', data: { campaigns: items, total, page, pageSize: limit } });
}

export async function getCampaign(req: Request, res: Response) {
  const campaign = await campaignService.getCampaign(req.params.id as string, req.user!);

  if (!campaign) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }

  res.json({ status: 'success', data: { campaign } });
}

export async function listTrafficSources(req: Request, res: Response) {
  const sources = await trafficSourceService.listSourcesForCampaign(req.params.id as string, req.user!);
  res.json({ status: 'success', data: { sources } });
}

// Sam Loom 2026-05-15: surface LeadByte per-buyer caps without leaving Stato.
// Read-only — LeadByte UI remains the write surface for delivery rules.
export async function listCampaignDeliveries(req: Request, res: Response) {
  const deliveries = await campaignService.getCampaignDeliveries(req.params.id as string);
  if (deliveries === null) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }
  res.json({ status: 'success', data: { deliveries } });
}

// Sam Loom #42-46: leadreports.io-style CRUD on per-campaign traffic
// sources. Each row maps a supplier (Facebook/Google/...) → Catchr NCP →
// ad-spend and surfaces revenue + net profit.

export async function createTrafficSource(req: Request, res: Response) {
  const source = await trafficSourceService.createSource(
    req.params.id as string,
    req.body,
    req.user!,
  );
  if (!source) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { source } });
}

export async function updateTrafficSource(req: Request, res: Response) {
  const source = await trafficSourceService.updateSource(
    req.params.id as string,
    req.params.sourceId as string,
    req.body,
    req.user!,
  );
  if (!source) {
    res.status(404).json({ status: 'error', message: 'Source not found' });
    return;
  }
  res.json({ status: 'success', data: { source } });
}

export async function deleteTrafficSource(req: Request, res: Response) {
  const ok = await trafficSourceService.deleteSource(
    req.params.id as string,
    req.params.sourceId as string,
    req.user!,
  );
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Source not found' });
    return;
  }
  res.status(204).end();
}

/**
 * PATCH /api/v1/campaigns/:id — Sam #41. Currently only cost_per_lead is
 * editable; other campaign metadata syncs from LeadByte.
 */
export async function updateCampaign(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await campaignService.updateCampaign(id, req.body, req.user!);
  if (!result) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }
  res.json({ status: 'success', data: { campaign: result } });
}
