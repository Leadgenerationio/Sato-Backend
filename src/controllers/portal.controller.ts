import { Request, Response, NextFunction } from 'express';
import * as portalService from '../services/portal.service.js';

function handlePortalError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Error && err.name === 'PortalAccessError') {
    res.status(403).json({ status: 'error', message: err.message });
    return;
  }
  next(err);
}

export async function dashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await portalService.getDashboard(req.user!);
    res.json({ status: 'success', data });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function campaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const campaigns = await portalService.getCampaigns(req.user!);
    res.json({ status: 'success', data: { campaigns } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function leads(req: Request, res: Response, next: NextFunction) {
  try {
    const leads = await portalService.getLeads(req.user!);
    res.json({ status: 'success', data: { leads } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function invoices(req: Request, res: Response, next: NextFunction) {
  try {
    const invoices = await portalService.getInvoices(req.user!);
    res.json({ status: 'success', data: { invoices } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function compliance(req: Request, res: Response, next: NextFunction) {
  try {
    const compliance = await portalService.getCompliance(req.user!);
    res.json({ status: 'success', data: { compliance } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function agreement(req: Request, res: Response, next: NextFunction) {
  try {
    const agreement = await portalService.getAgreement(req.user!);
    res.json({ status: 'success', data: { agreement } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}
