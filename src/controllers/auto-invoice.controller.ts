import { Request, Response } from 'express';
import * as autoInvoiceService from '../services/auto-invoice.service.js';
import { logger } from '../utils/logger.js';

export async function listRuns(req: Request, res: Response) {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const runs = await autoInvoiceService.listAutoInvoiceRuns(req.user!, limit);
  res.json({ status: 'success', data: { runs } });
}

export async function getRun(req: Request, res: Response) {
  const run = await autoInvoiceService.getAutoInvoiceRun(req.params.id as string, req.user!);
  if (!run) {
    res.status(404).json({ status: 'error', message: 'Run not found' });
    return;
  }
  res.json({ status: 'success', data: { run } });
}

export async function runNow(req: Request, res: Response) {
  try {
    const result = await autoInvoiceService.runAutoInvoiceManual(req.user!);
    res.json({ status: 'success', data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Auto-invoice run failed';
    logger.error({ err }, 'Manual auto-invoice run failed');
    res.status(500).json({ status: 'error', message: msg });
  }
}

export async function nextWindow(_req: Request, res: Response) {
  const week = autoInvoiceService.previousBillingWeek();
  res.json({ status: 'success', data: { ...week, schedule: 'Mondays 09:00 UTC' } });
}
