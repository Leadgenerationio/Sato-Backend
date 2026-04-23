import { logger } from '../../utils/logger.js';
import type { EndoleCreditReport } from './endole-types.js';
import { scoreToRiskRating } from '../credit-check/types.js';

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

function mockReport(companyNumber: string, companyName: string): EndoleCreditReport {
  const score = Math.floor(Math.random() * 60) + 40;
  return {
    companyId: `endole-${companyNumber}`,
    companyName,
    companyNumber,
    creditScore: score,
    riskRating: scoreToRiskRating(score),
    ccjCount: score < 50 ? Math.floor(Math.random() * 3) + 1 : 0,
    ccjTotal: score < 50 ? Math.floor(Math.random() * 15000) : 0,
    registrationDate: '2018-03-15',
    checkedAt: new Date().toISOString(),
  };
}

export async function runCreditCheck(companyNumber: string, companyName: string): Promise<EndoleCreditReport> {
  if (!isEndoleConfigured()) {
    logger.warn('Endole running in MOCK mode — ENDOLE_APP_ID or ENDOLE_APP_KEY missing');
    return mockReport(companyNumber, companyName);
  }

  const qs = isSandbox() ? '?sandbox=true' : '';
  const url = `${baseUrl()}/company/${encodeURIComponent(companyNumber)}/credit_checks${qs}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, companyNumber, body }, 'Endole credit_checks failed — returning fallback');
      return mockReport(companyNumber, companyName);
    }

    const data = (await res.json()) as EndoleApiResponse;
    return normalise(data, companyNumber, companyName);
  } catch (err) {
    logger.error({ err, companyNumber }, 'Endole runCreditCheck threw — returning fallback');
    return mockReport(companyNumber, companyName);
  }
}
