import type { Request, Response } from 'express';
import * as service from '../services/client-campaigns.service.js';

export async function listForCampaign(req: Request, res: Response) {
  const campaignId = req.params.id as string;
  const links = await service.listClientsForCampaign(campaignId, req.user!);
  if (links === null) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }
  res.json({ status: 'success', data: { clients: links } });
}

export async function listForClient(req: Request, res: Response) {
  const clientId = req.params.id as string;
  const links = await service.listCampaignsForClient(clientId, req.user!);
  if (links === null) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { campaigns: links } });
}

export async function link(req: Request, res: Response) {
  const campaignId = req.params.id as string;
  const result = await service.linkClientToCampaign(campaignId, req.body, req.user!);
  if (!result) {
    res.status(404).json({ status: 'error', message: 'Campaign or client not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { link: result } });
}

export async function unlink(req: Request, res: Response) {
  const campaignId = req.params.id as string;
  const clientId = req.params.clientId as string;
  const ok = await service.unlinkClientFromCampaign(campaignId, clientId, req.user!);
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Link not found' });
    return;
  }
  res.status(204).end();
}
