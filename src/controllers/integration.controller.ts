import { Request, Response } from 'express';
import * as xeroClient from '../integrations/xero/xero-client.js';
import * as vatService from '../services/vat.service.js';
import { isLeadByteConfigured } from '../integrations/leadbyte/leadbyte-client.js';
import { getActiveProvider } from '../integrations/credit-check/index.js';
import { isResendConfigured } from '../integrations/resend/resend-client.js';
import { isSignNowConfigured } from '../integrations/signnow/signnow-client.js';
import { isR2Configured } from '../integrations/r2/r2-client.js';
import { isCatchrConfigured } from '../integrations/catchr/catchr-client.js';
import { getLastCatchrSyncAt } from './ad-spend.controller.js';
import { syncQueue } from '../jobs/queue.js';
import { cached } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

// Xero balances + VAT change slowly. Caching their server-side fetches
// dramatically smooths the dashboard — every user that opens the dashboard
// in the next 5 / 15 min gets the cached payload (~10ms) instead of a
// fresh 700-1000ms Xero round-trip. Xero docs explicitly support this
// access pattern; balances are end-of-day-accurate, not minute-accurate.
const XERO_BANK_TTL_SECONDS = 300;   // 5 min
const XERO_VAT_TTL_SECONDS = 900;    // 15 min — VAT moves quarterly

let lastLeadByteSyncAt: string | null = null;
export function recordLeadByteSync(ts: string): void {
  lastLeadByteSyncAt = ts;
}

/**
 * Xero uses a Custom Connection (server-to-server) — no user-facing OAuth
 * consent flow. Status/disconnect are the only routes needed; authentication
 * is implicit from config.
 */
export async function xeroStatus(_req: Request, res: Response) {
  // If a token hasn't been fetched yet but creds are configured, try to
  // authenticate now so the UI shows "Connected" right away.
  if (xeroClient.isXeroConfigured()) {
    try {
      await xeroClient.getValidToken();
    } catch (err) {
      logger.warn({ err }, 'Xero authentication failed on /status');
    }
  }

  const status = await xeroClient.getStatus();
  res.json({ status: 'success', data: status });
}

export async function xeroDisconnect(_req: Request, res: Response) {
  xeroClient.disconnect();
  res.json({ status: 'success', data: { connected: false } });
}

/**
 * Net VAT liability since end of last completed UK quarter.
 * Falls back to { configured:false } when Xero env vars unset.
 */
export async function xeroVatLiability(_req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.json({ status: 'success', data: { configured: false } });
    return;
  }
  const fromDate = vatService.vatPeriodFromDate();
  const toDate = vatService.todayIso();
  try {
    // Cache the live Xero TaxSummary fetch — VAT is quarterly so 15 min
    // is fresh enough, and Xero's response time is one of our slowest
    // upstream calls (~700ms). Cache key includes the date range so
    // crossing a quarter boundary invalidates naturally.
    const liability = await cached(
      `xero:vat:${fromDate}:${toDate}`,
      XERO_VAT_TTL_SECONDS,
      () => xeroClient.getVatLiability(fromDate, toDate),
    );
    res.json({ status: 'success', data: { configured: true, ...liability, currency: 'GBP' } });
  } catch (err) {
    logger.warn({ err }, 'Xero VAT liability fetch failed');
    res.json({
      status: 'success',
      data: {
        configured: true,
        fromDate,
        toDate,
        currency: 'GBP',
        error: err instanceof Error ? err.message : 'fetch failed',
      },
    });
  }
}

/**
 * Live bank-account balances from Xero. Returns empty array if Xero isn't
 * configured or fails — frontend falls back to a "not connected" state.
 */
export async function xeroBankAccounts(_req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.json({ status: 'success', data: { configured: false, accounts: [] } });
    return;
  }
  try {
    // Cache bank balances for 5 minutes — they're end-of-day-accurate
    // anyway, and the live fetch is ~900ms (slowest dashboard widget).
    // Every dashboard mount in the next 5 min pays ~10ms instead.
    const accounts = await cached(
      'xero:bank-balances',
      XERO_BANK_TTL_SECONDS,
      () => xeroClient.getBankBalances(),
    );
    res.json({ status: 'success', data: { configured: true, accounts } });
  } catch (err) {
    logger.warn({ err }, 'Xero bank-balances fetch failed');
    res.json({ status: 'success', data: { configured: true, accounts: [], error: err instanceof Error ? err.message : 'fetch failed' } });
  }
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

// ─── SignNow (replaces DocuSign) ───

export async function signnowStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isSignNowConfigured(),
      baseUrl: process.env.SIGNNOW_BASE_URL || 'https://api-eval.signnow.com',
      username: process.env.SIGNNOW_USERNAME ? maskId(process.env.SIGNNOW_USERNAME) : null,
      sandbox: (process.env.SIGNNOW_BASE_URL || 'https://api-eval.signnow.com').includes('eval'),
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

// ─── Catchr ad-spend ───

export async function catchrStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      configured: isCatchrConfigured(),
      mcpUrl: process.env.CATCHR_MCP_URL || 'https://api.catchr.io/mcp',
      lastSyncAt: getLastCatchrSyncAt(),
    },
  });
}

function maskId(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
