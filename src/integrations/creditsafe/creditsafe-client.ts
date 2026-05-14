import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { CreditReport } from '../credit-check/types.js';
import { scoreToRiskRating } from '../credit-check/types.js';
import type {
  CreditsafeAuthResponse,
  CreditsafeCompanySearchResponse,
  CreditsafeReportResponse,
  CreditsafeReport,
} from './creditsafe-types.js';

/**
 * Creditsafe uses OAuth2 Client Credentials. Tokens last 1 hour; we cache
 * and refresh eagerly 60s before expiry.
 */
let cachedToken: { token: string; expiresAt: number } | null = null;

export function isCreditsafeConfigured(): boolean {
  // Creditsafe uses username/password OR API key depending on plan.
  // Sato stores the resolved API token (or credentials pair) in CREDITSAFE_API_KEY.
  return !!process.env.CREDITSAFE_API_KEY;
}

function baseUrl(): string {
  return (
    process.env.CREDITSAFE_BASE_URL ||
    env.CREDITSAFE_BASE_URL ||
    'https://connect.creditsafe.com'
  ).replace(/\/$/, '');
}

function apiKey(): string {
  return process.env.CREDITSAFE_API_KEY || '';
}

/**
 * Auth strategy depends on the credential format stored in `CREDITSAFE_API_KEY`:
 *   - `token:<bearer>` → use as-is
 *   - `<username>:<password>` → POST /authenticate to exchange for a bearer
 *   - anything else → treat as long-lived API token
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const raw = apiKey();
  if (raw.startsWith('token:')) {
    cachedToken = { token: raw.slice(6), expiresAt: Date.now() + 55 * 60_000 };
    return cachedToken.token;
  }

  if (raw.includes(':')) {
    const [username, password] = raw.split(':', 2);
    const res = await fetch(`${baseUrl()}/v1/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'Creditsafe authenticate failed');
      throw new Error(`Creditsafe auth failed: ${res.status}`);
    }
    const data = (await res.json()) as CreditsafeAuthResponse;
    cachedToken = { token: data.token, expiresAt: Date.now() + 55 * 60_000 };
    return cachedToken.token;
  }

  // Long-lived API token — use directly
  cachedToken = { token: raw, expiresAt: Date.now() + 55 * 60_000 };
  return cachedToken.token;
}

async function csFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, path, body }, 'Creditsafe GET failed');
    throw new Error(`Creditsafe GET ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Map Creditsafe's commonDescription → our 5-band risk rating. */
function normaliseRiskRating(desc: string | undefined, score: number): CreditReport['riskRating'] {
  if (desc) {
    const d = desc.toLowerCase();
    if (d.includes('very low')) return 'very_low';
    if (d.includes('low')) return 'low';
    if (d.includes('moderate') || d.includes('medium')) return 'moderate';
    if (d.includes('very high')) return 'very_high';
    if (d.includes('high')) return 'high';
  }
  return scoreToRiskRating(score);
}

function normalise(raw: CreditsafeReport, fallbackName: string, fallbackNumber: string): CreditReport {
  const score = Number(raw.creditScore?.currentCreditRating?.providerValue?.value) || 0;
  const risk = normaliseRiskRating(
    raw.creditScore?.currentCreditRating?.commonDescription,
    score,
  );
  const ccjSummary = raw.additionalInformation?.courtInformation?.courtJudgmentSummary;
  return {
    companyId: raw.companyId || `creditsafe-${fallbackNumber}`,
    companyName: raw.companySummary?.businessName || fallbackName,
    companyNumber: raw.companySummary?.companyNumber || fallbackNumber,
    creditScore: score,
    riskRating: risk,
    ccjCount: ccjSummary?.exactNumberOfJudgments ?? 0,
    ccjTotal: ccjSummary?.totalAmountOfJudgments?.value ?? 0,
    registrationDate: raw.companySummary?.companyRegistrationDate || '',
    checkedAt: new Date().toISOString(),
    source: 'creditsafe',
  };
}

/** Search for a company by registration number (UK only for Phase 1). */
async function findConnectId(companyNumber: string): Promise<string | null> {
  const qs = new URLSearchParams({ countries: 'gb', regNo: companyNumber });
  const data = await csFetch<CreditsafeCompanySearchResponse>(`/v1/companies?${qs}`);
  return data.companies?.[0]?.id ?? null;
}

/**
 * Run a Creditsafe credit check on a UK company by registration number.
 * When credentials are configured, real errors throw — the previous
 * "fall back to mock on error" behaviour silently produced fabricated
 * scores indistinguishable from real data, which is a no-fake-data
 * policy violation. The router (integrations/credit-check/index.ts)
 * handles the unconfigured case by throwing CreditProviderNotConfiguredError
 * before this function is even called.
 */
export async function runCreditCheck(companyNumber: string, companyName: string): Promise<CreditReport> {
  if (!isCreditsafeConfigured()) {
    // No-fake-data policy: refuse to fabricate. Router throws
    // CreditProviderNotConfiguredError before reaching here in the normal
    // path; this duplicate guard catches any direct caller. Removed the
    // previous Math.random() mockReport which returned 40-99 scores
    // indistinguishable from real Creditsafe data.
    throw new Error('Creditsafe not configured (missing CREDITSAFE_API_KEY) — refusing to fabricate a credit score');
  }

  const connectId = await findConnectId(companyNumber);
  if (!connectId) {
    // Genuine "company not found in Creditsafe DB" — distinct error so the
    // FE can show "Company X not registered with Creditsafe" instead of a
    // generic failure or fabricated score.
    throw new Error(`Creditsafe: company ${companyNumber} not found in their database`);
  }
  const res = await csFetch<CreditsafeReportResponse>(`/v1/companies/${connectId}/report`);
  return normalise(res.report, companyName, companyNumber);
}
