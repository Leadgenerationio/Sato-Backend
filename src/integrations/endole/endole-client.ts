import { logger } from '../../utils/logger.js';
import type { EndoleCreditReport } from './endole-types.js';
import { scoreToRiskRating } from '../credit-check/types.js';
import { CreditProviderError } from '../credit-check/errors.js';

/**
 * Endole API v1.1 — UK company credit checks.
 *
 * Auth: HTTP Basic with `{APP_ID}:{APP_KEY}` (base64 encoded).
 * Endpoint: GET /company/{companyNumber}/credit_checks
 * Sandbox mode: append ?sandbox=true (free, sample data, no credits charged).
 * Rate limit: 300 req / 5 min per app (HTTP 429 on breach).
 * IP whitelisting required before live calls (error code 104 otherwise).
 */

interface EndoleApiResponse {
  credit_scores?: {
    current_year_score?: number;
    current_year_band?: string;
  };
  ccj_cases?: Array<{ amount?: number }>;
  date_of_creation?: string;
}

function appId(): string {
  return process.env.ENDOLE_APP_ID || '';
}

function appKey(): string {
  return process.env.ENDOLE_APP_KEY || '';
}

function baseUrl(): string {
  return (process.env.ENDOLE_BASE_URL || 'https://api.endole.co.uk').replace(/\/$/, '');
}

function isSandbox(): boolean {
  return String(process.env.ENDOLE_SANDBOX || '').toLowerCase() === 'true';
}

export function isEndoleConfigured(): boolean {
  return !!(appId() && appKey());
}

function basicAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${appId()}:${appKey()}`).toString('base64');
}

/**
 * Endole returns free-text bands like "Very Low Risk", "Caution", "High Risk".
 * Map those to our 5-band enum. Fall back to score-based mapping if the text
 * is unfamiliar.
 */
function normaliseBand(band: string | undefined, score: number): EndoleCreditReport['riskRating'] {
  if (band) {
    const b = band.toLowerCase();
    if (b.includes('very low')) return 'very_low';
    if (b.includes('very high')) return 'very_high';
    if (b.includes('low')) return 'low';
    if (b.includes('high')) return 'high';
    if (b.includes('caution') || b.includes('moderate') || b.includes('medium')) return 'moderate';
  }
  return scoreToRiskRating(score);
}

function normalise(raw: EndoleApiResponse, companyNumber: string, companyName: string): EndoleCreditReport {
  const score = Number(raw.credit_scores?.current_year_score) || 0;
  const ccjs = raw.ccj_cases ?? [];
  const ccjTotal = ccjs.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  return {
    companyId: `endole-${companyNumber}`,
    companyName,
    companyNumber,
    creditScore: score,
    riskRating: normaliseBand(raw.credit_scores?.current_year_band, score),
    ccjCount: ccjs.length,
    ccjTotal,
    registrationDate: raw.date_of_creation ?? '',
    checkedAt: new Date().toISOString(),
  };
}

export async function runCreditCheck(companyNumber: string, companyName: string): Promise<EndoleCreditReport> {
  if (!isEndoleConfigured()) {
    // No-fake-data policy: never fabricate a credit score. The credit-check
    // router (integrations/credit-check/index.ts) throws
    // CreditProviderNotConfiguredError before reaching this path in the normal
    // call path; this duplicate guard catches any direct caller that bypasses
    // the router. Removed the previous Math.random() mockReport that returned
    // 40-99 scores indistinguishable from real data.
    throw new Error('Endole not configured (missing ENDOLE_APP_ID or ENDOLE_APP_KEY) — refusing to fabricate a credit score');
  }

  const qs = isSandbox() ? '?sandbox=true' : '';
  const url = `${baseUrl()}/company/${encodeURIComponent(companyNumber)}/credit_checks${qs}`;

  // When credentials are configured, surface real errors to the caller.
  // The previous "fabricate a mock score on error" behaviour silently masked
  // 401/403/429 issues and made the UI display fake credit data — caller
  // (client.service.ts) wraps this in try/catch and writes a system_error
  // notification, so throwing is the correct behaviour.
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, companyNumber, body }, 'Endole credit_checks failed');
    // Endole returns two shapes:
    //   1. { error: { code, message } }                          (most errors)
    //   2. { error: "...", error_code, error_type }              (billing/auth)
    // Parse both so we can identify the balance-exhausted case (error_code
    // "102") — that one needs a distinct FE message because the fix is for Sam
    // to top up endole.co.uk, not for a developer to investigate.
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* non-JSON body, leave null */ }
    const p = (parsed ?? {}) as { error?: unknown; error_code?: unknown };
    const nestedCode = typeof p.error === 'object' && p.error !== null
      ? (p.error as { code?: unknown }).code
      : undefined;
    const upstreamCode = String(p.error_code ?? nestedCode ?? '') || undefined;
    const upstreamMsg = typeof p.error === 'string'
      ? p.error
      : typeof p.error === 'object' && p.error !== null
        ? (p.error as { message?: unknown }).message as string | undefined
        : undefined;

    if (upstreamCode === '102') {
      throw new CreditProviderError(
        `Endole credit_checks failed: ${res.status} — provider balance exhausted (top up at endole.co.uk)`,
        { code: 'credit_provider_balance_exhausted', upstreamStatus: res.status, upstreamCode },
      );
    }
    const suffix = upstreamMsg ? ` — ${upstreamMsg}` : '';
    throw new CreditProviderError(
      `Endole credit_checks failed: ${res.status}${suffix}`,
      { code: 'credit_provider_failed', upstreamStatus: res.status, upstreamCode },
    );
  }

  const data = (await res.json()) as EndoleApiResponse;
  const report = normalise(data, companyNumber, companyName);
  // Info-level audit log of every successful credit check. Critical for
  // diagnosing "score looks wrong" reports — grep `endole-credit-check` in
  // logs to see exactly which provider/mode/company/score combination ran.
  // Sam's UK-Energy-Saving-Network mismatch (38 vs 54) is almost certainly
  // either sandbox=true (sample data) or a wrong companyNumber on the client
  // record; this log line surfaces both.
  logger.info(
    {
      provider: 'endole',
      sandbox: isSandbox(),
      companyNumber,
      companyName,
      score: report.creditScore,
      band: data.credit_scores?.current_year_band,
      ccjCount: report.ccjCount,
    },
    'endole-credit-check',
  );
  return report;
}
