import { Request, Response } from 'express';
import { and, gte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agreements } from '../db/schema/agreements.js';
import { creditChecks } from '../db/schema/credit-checks.js';
import { creatives } from '../db/schema/creatives.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { adSpend } from '../db/schema/ad-spend.js';
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
 * VAT liability for the most-recently-closed HMRC quarter (owed to HMRC)
 * AND the current open quarter (live accrual) — Sam Loom #7-12.
 *
 * Stagger is configured via XERO_VAT_STAGGER (1/2/3, default 1). Sam's CMS
 * org is stagger 2 (Feb–Apr, May–Jul, Aug–Oct, Nov–Jan).
 *
 * Returns both blocks with a human-readable `label` and per-call error
 * isolation so a transient TaxSummary failure for one window doesn't blank
 * the other.
 */
export async function xeroVatLiability(_req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.json({ status: 'success', data: { configured: false } });
    return;
  }
  const stagger = vatService.configuredStagger();
  const prev = vatService.lastCompletedQuarterRange();
  const curr = vatService.currentQuarterRange();

  const [prevResult, currResult] = await Promise.all([
    cached(
      `xero:vat:${prev.fromDate}:${prev.toDate}`,
      XERO_VAT_TTL_SECONDS,
      () => xeroClient.getVatLiability(prev.fromDate, prev.toDate),
    ).catch((err) => {
      logger.warn({ err, range: prev }, 'Xero VAT previous-quarter fetch failed');
      return { fromDate: prev.fromDate, toDate: prev.toDate, error: err instanceof Error ? err.message : 'fetch failed' };
    }),
    cached(
      `xero:vat:${curr.fromDate}:${curr.toDate}`,
      XERO_VAT_TTL_SECONDS,
      () => xeroClient.getVatLiability(curr.fromDate, curr.toDate),
    ).catch((err) => {
      logger.warn({ err, range: curr }, 'Xero VAT current-quarter fetch failed');
      return { fromDate: curr.fromDate, toDate: curr.toDate, error: err instanceof Error ? err.message : 'fetch failed' };
    }),
  ]);

  res.json({
    status: 'success',
    data: {
      configured: true,
      currency: 'GBP',
      stagger,
      previousQuarter: { ...prevResult, label: prev.label },
      currentQuarter: { ...currResult, label: curr.label },
    },
  });
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
  // Endole sandbox returns sample data, not real scores — surface this loudly
  // so admins know why the integrations page shows a connected-but-fake state.
  const endoleSandbox = String(process.env.ENDOLE_SANDBOX || '').toLowerCase() === 'true';
  res.json({
    status: 'success',
    data: {
      provider,
      configured: provider !== 'mock',
      sandbox: provider === 'endole' ? endoleSandbox : false,
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

// ─── Aggregate overview ───
//
// Single round-trip for the visual /integrations dashboard. Each card needs
// its connection status + a key live metric. We run all DB counts in parallel
// and cache the whole payload for 60s — owner-only page, opened occasionally,
// metrics don't need second-precision freshness.

const OVERVIEW_TTL_SECONDS = 60;

function startOfMonthIso(): string {
  return new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .split('T')[0];
}

function thirtyDaysAgoIso(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];
}

async function buildOverview() {
  const monthStart = startOfMonthIso();
  const thirtyDaysAgo = thirtyDaysAgoIso();

  const [
    agreementCountRow,
    creditCheckCountRow,
    creativeCountRow,
    leadsThisMonthRow,
    adSpend30dRow,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(agreements),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creditChecks),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creatives),
    db
      .select({ count: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(gte(leadDeliveries.deliveryDate, monthStart)),
    db
      .select({ total: sql<number>`coalesce(sum(${adSpend.spend}), 0)::float8` })
      .from(adSpend)
      .where(and(gte(adSpend.date, thirtyDaysAgo))),
  ]);

  const xeroConfigured = xeroClient.isXeroConfigured();
  let xeroConnected = false;
  let xeroTenantName: string | null = null;
  if (xeroConfigured) {
    try {
      const status = await xeroClient.getStatus();
      xeroConnected = status.connected ?? false;
      xeroTenantName = status.tenantName ?? null;
    } catch (err) {
      logger.warn({ err }, 'Xero status fetch failed in overview');
    }
  }

  const creditProvider = getActiveProvider();

  return {
    xero: {
      configured: xeroConfigured,
      connected: xeroConnected,
      tenantName: xeroTenantName,
    },
    leadbyte: {
      configured: isLeadByteConfigured(),
      lastSyncAt: lastLeadByteSyncAt,
      leadsThisMonth: leadsThisMonthRow[0]?.count ?? 0,
    },
    catchr: {
      configured: isCatchrConfigured(),
      lastSyncAt: getLastCatchrSyncAt(),
      adSpendLast30Days: Math.round((adSpend30dRow[0]?.total ?? 0) * 100) / 100,
      currency: 'GBP',
    },
    signnow: {
      configured: isSignNowConfigured(),
      sandbox: (process.env.SIGNNOW_BASE_URL || 'https://api-eval.signnow.com').includes('eval'),
      agreementCount: agreementCountRow[0]?.count ?? 0,
    },
    r2: {
      configured: isR2Configured(),
      bucket: process.env.R2_BUCKET || null,
      fileCount: creativeCountRow[0]?.count ?? 0,
    },
    resend: {
      configured: isResendConfigured(),
      fromEmail: process.env.RESEND_FROM_EMAIL || null,
    },
    creditCheck: {
      configured: creditProvider !== 'mock',
      provider: creditProvider,
      checksRun: creditCheckCountRow[0]?.count ?? 0,
    },
  };
}

export async function overview(_req: Request, res: Response) {
  try {
    const data = await cached(
      'integrations:overview',
      OVERVIEW_TTL_SECONDS,
      buildOverview,
    );
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error({ err }, 'Integrations overview failed');
    res.status(500).json({ status: 'error', message: 'Failed to load integrations overview' });
  }
}
