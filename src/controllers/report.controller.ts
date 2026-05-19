import { Request, Response } from 'express';
import * as reportService from '../services/report.service.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';
import { parseDashboardWindow } from '../utils/dashboard-window.js';

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
  // Optional ?window= (dashboard time-range dropdown) — controls how many
  // monthly buckets the BE returns. Unknown / missing → undefined → BE
  // default = 12 months, matching the pre-filter chart behaviour.
  const window = parseDashboardWindow(req.query.window) ?? undefined;
  const data = await reportService.getFinancialOverview(req.user!, { window });
  res.json({ status: 'success', data: { report: data } });
}

export async function pnlSummary(req: Request, res: Response) {
  const days = req.query.days ? Math.max(1, Math.min(365, Number(req.query.days))) : 30;
  const data = await reportService.getPnlSummary(req.user!, days);
  res.json({ status: 'success', data });
}

/**
 * Slice 4 Day 1 — unified leadreports.io report (Sam #72-85).
 * Replaces the 5 separate report pages with one consolidated view that the
 * frontend will fold into in Day 2-4 of the slice.
 */
export async function unifiedReport(req: Request, res: Response) {
  const window = parseWindow(req.query.window);
  const supplier = typeof req.query.supplier === 'string' ? req.query.supplier : undefined;
  const campaign = typeof req.query.campaign === 'string' ? req.query.campaign : undefined;
  const data = await reportService.getUnifiedReport(req.user!, { window, supplier, campaign });
  res.json({
    status: 'success',
    data: {
      window,
      supplier: supplier ?? null,
      campaign: campaign ?? null,
      ...data,
    },
  });
}
