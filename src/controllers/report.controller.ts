import { Request, Response } from 'express';
import * as reportService from '../services/report.service.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';

const VALID_WINDOWS: DeliveryWindow[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'ytd'];

function parseWindow(input: unknown): DeliveryWindow {
  return VALID_WINDOWS.includes(input as DeliveryWindow) ? (input as DeliveryWindow) : 'this_month';
}

export async function campaignPerformance(req: Request, res: Response) {
  const window = parseWindow(req.query.window);
  const data = await reportService.getCampaignPerformance(req.user!, window);
  res.json({ status: 'success', data: { report: data, window } });
}

export async function clientPnl(req: Request, res: Response) {
  const data = await reportService.getClientPnl(req.user!);
  res.json({ status: 'success', data: { report: data } });
}

export async function supplierPerformance(req: Request, res: Response) {
  const window = parseWindow(req.query.window);
  const data = await reportService.getSupplierPerformance(req.user!, window);
  res.json({ status: 'success', data: { report: data, window } });
}

export async function financialOverview(req: Request, res: Response) {
  const data = await reportService.getFinancialOverview(req.user!);
  res.json({ status: 'success', data: { report: data } });
}

export async function pnlSummary(req: Request, res: Response) {
  const days = req.query.days ? Math.max(1, Math.min(365, Number(req.query.days))) : 30;
  const data = await reportService.getPnlSummary(req.user!, days);
  res.json({ status: 'success', data });
}
