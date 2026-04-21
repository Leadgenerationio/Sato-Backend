import { Request, Response } from 'express';
import * as xeroClient from '../integrations/xero/xero-client.js';
import { isLeadByteConfigured } from '../integrations/leadbyte/leadbyte-client.js';
import { getActiveProvider } from '../integrations/credit-check/index.js';
import { isResendConfigured } from '../integrations/resend/resend-client.js';
import { isDocuSignConfigured } from '../integrations/docusign/docusign-client.js';
import { isR2Configured } from '../integrations/r2/r2-client.js';
import { syncQueue } from '../jobs/queue.js';
import { logger } from '../utils/logger.js';

let lastLeadByteSyncAt: string | null = null;
export function recordLeadByteSync(ts: string): void {
  lastLeadByteSyncAt = ts;
}

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

// ─── LeadByte ───

export async function leadbyteStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isLeadByteConfigured(),
      lastSyncAt: lastLeadByteSyncAt,
    },
  });
}

export async function leadbyteSyncNow(_req: Request, res: Response) {
  if (!syncQueue) {
    res.status(503).json({ status: 'error', message: 'Background queue not available (Redis not configured)' });
    return;
  }
  const job = await syncQueue.add('leadbyte-hourly-sync', { triggeredBy: 'manual' });
  logger.info({ jobId: job.id }, 'Manual LeadByte sync enqueued');
  res.json({ status: 'success', data: { jobId: job.id, enqueuedAt: new Date().toISOString() } });
}

// ─── Credit check ───

export async function creditCheckStatus(_req: Request, res: Response) {
  const provider = getActiveProvider();
  res.json({
    status: 'success',
    data: {
      provider,
      configured: provider !== 'mock',
      checksRun: 0,
    },
  });
}

// ─── Resend ───

export async function resendStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isResendConfigured(),
      fromEmail: process.env.RESEND_FROM_EMAIL || null,
      fromName: process.env.RESEND_FROM_NAME || null,
    },
  });
}

// ─── DocuSign ───

export async function docusignStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isDocuSignConfigured(),
      accountId: process.env.DOCUSIGN_ACCOUNT_ID ? maskId(process.env.DOCUSIGN_ACCOUNT_ID) : null,
      oauthBase: process.env.DOCUSIGN_OAUTH_BASE || null,
    },
  });
}

// ─── R2 storage ───

export async function r2Status(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isR2Configured(),
      bucket: process.env.R2_BUCKET || null,
      publicBaseUrl: process.env.R2_PUBLIC_URL || null,
    },
  });
}

function maskId(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
