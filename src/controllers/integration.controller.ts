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
import {
  isCatchrConfigured,
  listSources as listCatchrSources,
  listPlatforms as listCatchrPlatforms,
} from '../integrations/catchr/catchr-client.js';
import { getLastCatchrSyncAt } from './ad-spend.controller.js';
import { syncQueue } from '../jobs/queue.js';
import { cached } from '../utils/cache.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

// Xero balances + VAT change slowly. Caching their server-side fetches
// dramatically smooths the dashboard — every user that opens the dashboard
// in the next 5 / 15 min gets the cached payload (~10ms) instead of a
// fresh 700-1000ms Xero round-trip. Xero docs explicitly support this
// access pattern; balances are end-of-day-accurate, not minute-accurate.
const XERO_BANK_TTL_SECONDS = 300;   // 5 min
// VAT data moves quarterly, not by-minute, and Xero rate-limits the
// TaxSummary endpoint hard. 60min cache reduces miss-during-429 risk
// from "every page refresh" to "once per hour" without sacrificing
// any meaningful freshness.
const XERO_VAT_TTL_SECONDS = 3600;   // 60 min — VAT moves quarterly

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
 * Aggregate health report for the Xero integration. Returns scopes, bound
 * tenant, bank-account count, VAT registration state, Finance API
 * availability, plus a plain-English next-steps list so the operator can
 * see exactly which Xero-side change unblocks the empty Bank / VAT widgets
 * without digging through Railway logs.
 */
export async function xeroHealth(_req: Request, res: Response) {
  const health = await xeroClient.getHealth();
  res.json({ status: 'success', data: health });
}

/**
 * Diagnostic endpoint for the client-create Xero auto-bind. Runs each
 * lookup strategy independently and returns what each one returns, so we
 * can debug why a given client isn't getting auto-bound.
 *
 * Either pass `clientId` (preferred — uses the client's existing fields)
 * OR pass `name` and/or `companyNumber` directly.
 *
 * Also fetches the FULL Xero contact record if the client already has an
 * xero_contact_id — exposes the exact Name + CompanyNumber + EmailAddress
 * Xero has stored, so we can see why our search isn't matching.
 *
 * Owner-only (already gated in the route).
 */
export async function xeroDiagnoseContact(req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.status(503).json({ status: 'error', message: 'Xero not configured' });
    return;
  }

  let name: string | null = (req.query.name as string | undefined) ?? null;
  let companyNumber: string | null = (req.query.companyNumber as string | undefined) ?? null;
  let boundContactId: string | null = null;
  let clientRow: { id: string; companyName: string; companyNumber: string | null; xeroContactId: string | null } | null = null;

  const clientIdParam = req.query.clientId as string | undefined;
  if (clientIdParam) {
    const { clients } = await import('../db/schema/clients.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({
        id: clients.id,
        companyName: clients.companyName,
        companyNumber: clients.companyNumber,
        xeroContactId: clients.xeroContactId,
      })
      .from(clients)
      .where(eq(clients.id, clientIdParam));
    if (!row) {
      res.status(404).json({ status: 'error', message: 'Client not found' });
      return;
    }
    clientRow = row;
    name = name ?? row.companyName;
    companyNumber = companyNumber ?? row.companyNumber;
    boundContactId = row.xeroContactId;
  }

  // Run all 3 strategies independently — capture per-strategy success / null / error.
  const strategies: Record<string, { query: string; ok: boolean; match: { contactId: string; name: string } | null; error: string | null }> = {};

  if (companyNumber) {
    strategies.byCompanyNumber = { query: `CompanyNumber=="${companyNumber}"`, ok: false, match: null, error: null };
    try {
      const match = await xeroClient.findContactByCompanyNumber(companyNumber);
      strategies.byCompanyNumber.ok = true;
      strategies.byCompanyNumber.match = match;
    } catch (err) {
      strategies.byCompanyNumber.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (name) {
    strategies.byExactName = { query: `Name=="${name}"`, ok: false, match: null, error: null };
    try {
      const match = await xeroClient.findContactByName(name);
      strategies.byExactName.ok = true;
      strategies.byExactName.match = match;
    } catch (err) {
      strategies.byExactName.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Substring search uses the same base-name normalisation findContactBestMatch does.
  if (name) {
    const base = name.replace(/\s+(corporation|limited|llc|plc|ltd|inc|corp|co)\.?$/i, '').trim();
    strategies.bySubstring = { query: `Name.ToLower().Contains("${base.toLowerCase()}")`, ok: false, match: null, error: null };
    try {
      const match = await xeroClient.findContactBestMatch(name, null);
      strategies.bySubstring.ok = true;
      // bestMatch tries exact name first — only report a substring match if exact-name failed.
      const isSubstringHit = match && strategies.byExactName?.match?.contactId !== match.contactId;
      strategies.bySubstring.match = isSubstringHit ? match : null;
    } catch (err) {
      strategies.bySubstring.error = err instanceof Error ? err.message : String(err);
    }
  }

  // If a contact is already bound, dump its full Xero record so we can see
  // exactly what fields Xero has — and whether our searches should have
  // matched in the first place.
  let boundContact: Awaited<ReturnType<typeof xeroClient.getContactById>> | null = null;
  let boundContactError: string | null = null;
  if (boundContactId) {
    try {
      boundContact = await xeroClient.getContactById(boundContactId);
    } catch (err) {
      boundContactError = err instanceof Error ? err.message : String(err);
    }
  }

  res.json({
    status: 'success',
    data: {
      input: { name, companyNumber, clientId: clientIdParam ?? null },
      client: clientRow,
      strategies,
      boundContact,
      boundContactError,
    },
  });
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
export async function xeroVatLiability(req: Request, res: Response) {
  if (!xeroClient.isXeroConfigured()) {
    res.json({ status: 'success', data: { configured: false } });
    return;
  }
  const stagger = vatService.configuredStagger();
  const prev = vatService.lastCompletedQuarterRange();
  const curr = vatService.currentQuarterRange();

  // Sam Loom #12 — clients can request up to 8 historical quarters via
  // ?history=N. Default 0 keeps the response cheap for the default
  // dashboard widget mount; the widget asks for ?history=4 only when the
  // user expands the "Past quarters" section.
  const requestedHistory = Math.max(
    0,
    Math.min(8, Number.parseInt((req.query.history as string) || '0', 10) || 0),
  );
  const historyRanges = requestedHistory > 0
    ? vatService.historicalQuarters(requestedHistory)
    : [];

  // Stale-while-revalidate for VAT: when Xero is rate-limiting (or any other
  // upstream failure), serve the last-known-good response from a 7-day "stale"
  // key instead of an error toast. Primary cache lives 1h via `cached()`; on
  // every successful fetch we also write a 7-day mirror under
  // `xero:vat:lastgood:*`. Empty result still wins as primary (no point keeping
  // a 0-VAT stale value around).
  async function fetchRange(r: { fromDate: string; toDate: string; label?: string }) {
    const lastGoodKey = `xero:vat:lastgood:${r.fromDate}:${r.toDate}`;
    try {
      const fresh = await cached(
        `xero:vat:${r.fromDate}:${r.toDate}`,
        XERO_VAT_TTL_SECONDS,
        () => xeroClient.getVatLiability(r.fromDate, r.toDate),
      );
      // Persist last-known-good for SWR fallback. 7-day TTL is well clear of
      // any realistic Xero rate-limit lockout window.
      if (redis && redis.status === 'ready') {
        redis.set(lastGoodKey, JSON.stringify(fresh), 'EX', 7 * 24 * 3600)
          .catch((err) => logger.warn({ err, lastGoodKey }, 'VAT lastgood write failed'));
      }
      return fresh;
    } catch (err) {
      logger.warn({ err, range: r }, 'Xero VAT fetch failed — trying lastgood');
      if (redis && redis.status === 'ready') {
        try {
          const stale = await redis.get(lastGoodKey);
          if (stale) {
            const parsed = JSON.parse(stale);
            logger.info({ range: r }, 'Serving stale VAT (SWR fallback)');
            return { ...parsed, _stale: true };
          }
        } catch (readErr) {
          logger.warn({ readErr, lastGoodKey }, 'VAT lastgood read failed');
        }
      }
      return { fromDate: r.fromDate, toDate: r.toDate, error: err instanceof Error ? err.message : 'fetch failed' };
    }
  }

  const [prevResult, currResult, ...historyResults] = await Promise.all([
    fetchRange(prev),
    fetchRange(curr),
    ...historyRanges.map((r) => fetchRange(r)),
  ]);

  res.json({
    status: 'success',
    data: {
      configured: true,
      currency: 'GBP',
      stagger,
      previousQuarter: { ...prevResult, label: prev.label },
      currentQuarter: { ...currResult, label: curr.label },
      history: historyResults.map((r, i) => ({ ...r, label: historyRanges[i].label })),
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

// Cache list-sources for a few minutes — the account list rarely changes
// (Sam's connected ad accounts are stable across sessions) and the MCP
// round-trip is ~600-1200ms because of session handshake overhead.
const CATCHR_ACCOUNTS_TTL_SECONDS = 300;

/**
 * Catchr platforms list (slug + display name). The Stato UI fetches this
 * at runtime so the supplier dropdown stays in sync with whatever Sam has
 * actually connected on Catchr — no hardcoded list to maintain, no slug
 * mismatch ever again (e.g. our old 'facebook' UI key vs Catchr's
 * 'facebook-ads'). Sam called out the picker showing "No facebook accounts
 * found" on 2026-05-15 — root cause was exactly that mismatch.
 */
export interface CatchrPlatformOption {
  id: string;
  name: string;
  connected: boolean;
}

const CATCHR_PLATFORMS_TTL_SECONDS = 600; // 10 min — connected-platforms list barely changes

export interface CatchrAccountSummary {
  /** Catchr account identifier — what we persist into traffic_sources.account_id. */
  id: string;
  /** Human label shown in the dropdown. */
  name: string;
  /** Normalised platform key (facebook/google/bing/...). */
  platform: string;
  /** Catchr's parent source row — useful for "Open in Catchr" deep-links. */
  sourceName: string;
}

/**
 * List Catchr ad accounts the user can pick from when configuring a
 * traffic source — Sam's 2026-05-15 Loom: the campaign-source UI was
 * forcing users to paste a Catchr URL by hand, when the Catchr API
 * already exposes the same dropdown leadreports.io renders. With a
 * platform filter we return only Facebook accounts when the user picks
 * Facebook (etc); without it we return everything so a single fetch
 * powers a fully-populated combobox in the future.
 *
 * Returns `{ accounts: [] }` when Catchr isn't configured so the UI
 * can gracefully fall back to manual entry without a 500.
 */
export async function catchrAccounts(req: Request, res: Response) {
  if (!isCatchrConfigured()) {
    res.json({ status: 'success', data: { configured: false, accounts: [] } });
    return;
  }
  // The picker now uses Catchr's canonical slugs (e.g. 'facebook-ads')
  // end-to-end, populated dynamically from /catchr/platforms. No more
  // UI→Catchr slug translation step.
  const platform = String(req.query.platform ?? '').trim();
  try {
    const result = await cached(
      `catchr:accounts:${platform || 'all'}`,
      CATCHR_ACCOUNTS_TTL_SECONDS,
      () => listCatchrSources({ platform: platform || undefined, includeAvailableAccounts: true }),
    );
    const accounts: CatchrAccountSummary[] = (result.sources ?? []).flatMap((src) =>
      (src.available_accounts ?? []).map((acct) => ({
        id: String(acct.id),
        name: acct.name,
        platform: String(src.platform || '').toLowerCase(),
        sourceName: src.name,
      })),
    );
    res.json({ status: 'success', data: { configured: true, accounts } });
  } catch (err) {
    logger.warn({ err, platform }, 'Catchr listSources failed in /accounts');
    res.json({
      status: 'success',
      data: {
        configured: true,
        accounts: [],
        error: err instanceof Error ? err.message : 'Catchr fetch failed',
      },
    });
  }
}

/**
 * List Catchr platforms (Facebook Ads, Google Ads, etc.) so the supplier
 * dropdown in the campaign Traffic Sources UI is driven by what Sam has
 * connected on Catchr, not by a hardcoded list that drifts. Default
 * `connected=true` keeps the picker focused on actionable platforms.
 *
 * Sam's 2026-05-15 Loom: the previous hardcoded list mapped 'facebook' →
 * 'facebook-ads' manually and missed everything else Catchr supports
 * (every other Ads/Analytics platform). With this endpoint the picker is
 * always in sync with his actual Catchr workspace.
 */
export async function catchrPlatforms(req: Request, res: Response) {
  if (!isCatchrConfigured()) {
    res.json({ status: 'success', data: { configured: false, platforms: [] } });
    return;
  }
  const connectedOnly = String(req.query.connected ?? 'true').toLowerCase() !== 'false';
  try {
    const result = await cached(
      `catchr:platforms:${connectedOnly ? 'connected' : 'all'}`,
      CATCHR_PLATFORMS_TTL_SECONDS,
      () => listCatchrPlatforms(connectedOnly),
    );
    const platforms: CatchrPlatformOption[] = (result.platforms ?? []).map((p) => ({
      id: String(p.id),
      name: p.name,
      connected: p.connected,
    }));
    res.json({ status: 'success', data: { configured: true, platforms } });
  } catch (err) {
    logger.warn({ err, connectedOnly }, 'Catchr listPlatforms failed');
    res.json({
      status: 'success',
      data: {
        configured: true,
        platforms: [],
        error: err instanceof Error ? err.message : 'Catchr fetch failed',
      },
    });
  }
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

// Short cache so the integrations page reflects a fresh Xero re-auth
// within a few seconds instead of sitting on a stale "Auth pending"
// value until the previous cache window expires. The expensive DB
// counts are still de-duplicated within the window.
const OVERVIEW_TTL_SECONDS = 15;

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
  let xeroError: string | null = null;
  if (xeroConfigured) {
    try {
      const status = await xeroClient.getStatus();
      xeroConnected = status.connected ?? false;
      xeroTenantName = status.tenantName ?? null;
      xeroError = status.lastError ?? null;
    } catch (err) {
      logger.warn({ err }, 'Xero status fetch failed in overview');
    }
  }

  // Probe Catchr the same way we probe Xero — actually call list_platforms
  // and surface the result on the Integrations card. Without this probe,
  // the card claimed "Live" while every call silently failed (Sam, 2026-
  // 05-15: "No facebook accounts" with no clue why). Cap the probe at 3s
  // so a slow/unreachable Catchr can't stall the whole Integrations page.
  const catchrConfigured = isCatchrConfigured();
  let catchrConnected = false;
  let catchrPlatformsCount = 0;
  let catchrError: string | null = null;
  if (catchrConfigured) {
    try {
      const result = await Promise.race([
        cached(
          'catchr:probe:platforms',
          CATCHR_PLATFORMS_TTL_SECONDS,
          () => listCatchrPlatforms(true),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Catchr probe timed out after 3s')), 3000),
        ),
      ]);
      catchrPlatformsCount = (result.platforms ?? []).filter((p) => p.connected).length;
      catchrConnected = catchrPlatformsCount > 0;
    } catch (err) {
      catchrError = err instanceof Error ? err.message : 'Catchr fetch failed';
      logger.warn({ err }, 'Catchr probe failed in overview');
    }
  }

  const creditProvider = getActiveProvider();

  return {
    xero: {
      configured: xeroConfigured,
      connected: xeroConnected,
      tenantName: xeroTenantName,
      lastError: xeroError,
    },
    leadbyte: {
      configured: isLeadByteConfigured(),
      lastSyncAt: lastLeadByteSyncAt,
      leadsThisMonth: leadsThisMonthRow[0]?.count ?? 0,
    },
    catchr: {
      configured: catchrConfigured,
      connected: catchrConnected,
      platformsConnected: catchrPlatformsCount,
      lastError: catchrError,
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
    // Warm the Xero token cache OUTSIDE the overview cache so a fresh
    // re-auth in the developer portal flips the UI from "Auth pending"
    // to "Live" on the very next request, instead of waiting for the
    // overview TTL to expire. getValidToken() is itself cached for the
    // token lifetime (~30 min) at the xero-client level, so this is a
    // no-op after the first successful exchange. Errors are swallowed —
    // buildOverview's getStatus() reports `connected:false` in that case.
    if (xeroClient.isXeroConfigured()) {
      try {
        await xeroClient.getValidToken();
      } catch (err) {
        logger.warn({ err }, 'Xero token warmup failed in overview');
      }
    }

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
