import { Request, Response } from 'express';
import * as portalService from '../services/portal.service.js';

export async function dashboard(req: Request, res: Response) {
  const data = await portalService.getDashboard(req.user!);
  res.json({ status: 'success', data });
}

export async function campaigns(req: Request, res: Response) {
  const campaigns = await portalService.getCampaigns(req.user!);
  res.json({ status: 'success', data: { campaigns } });
}

export async function leads(req: Request, res: Response) {
  const leads = await portalService.getLeads(req.user!);
  res.json({ status: 'success', data: { leads } });
}

export async function invoices(req: Request, res: Response) {
  const invoices = await portalService.getInvoices(req.user!);
  res.json({ status: 'success', data: { invoices } });
}

export async function compliance(req: Request, res: Response) {
  const compliance = await portalService.getCompliance(req.user!);
  res.json({ status: 'success', data: { compliance } });
}

export async function agreement(req: Request, res: Response) {
  const agreement = await portalService.getAgreement(req.user!);
  res.json({ status: 'success', data: { agreement } });
}
