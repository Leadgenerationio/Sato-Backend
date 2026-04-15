import { Request, Response } from 'express';
import * as xeroClient from '../integrations/xero/xero-client.js';

export async function xeroAuthUrl(_req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.status(503).json({ status: 'error', message: 'Xero credentials not configured' });
    return;
  }

  const url = await xeroClient.getAuthUrl();
  res.json({ status: 'success', data: { url } });
}

export async function xeroCallback(req: Request, res: Response) {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ status: 'error', message: 'Missing authorization code' });
    return;
  }

  const businessId = req.user!.businessId;
  if (!businessId) {
    res.status(400).json({ status: 'error', message: 'No business associated with your account' });
    return;
  }

  await xeroClient.exchangeCode(businessId, code);

  // Redirect back to frontend settings page
  res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?xero=connected`);
}

export async function xeroStatus(req: Request, res: Response) {
  const businessId = req.user!.businessId;
  if (!businessId) {
    res.json({ status: 'success', data: { connected: false, configured: xeroClient.isXeroConfigured() } });
    return;
  }

  const connectionStatus = await xeroClient.getStatus(businessId);
  res.json({
    status: 'success',
    data: {
      ...connectionStatus,
      configured: xeroClient.isXeroConfigured(),
    },
  });
}

export async function xeroDisconnect(req: Request, res: Response) {
  const businessId = req.user!.businessId;
  if (!businessId) {
    res.status(400).json({ status: 'error', message: 'No business associated with your account' });
    return;
  }

  await xeroClient.disconnect(businessId);
  res.json({ status: 'success', data: { connected: false } });
}
