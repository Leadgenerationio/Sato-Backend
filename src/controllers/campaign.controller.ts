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
