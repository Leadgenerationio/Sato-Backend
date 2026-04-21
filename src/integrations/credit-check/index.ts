/**
 * Credit-check provider router. Auto-selects the provider based on env:
 *   1. Creditsafe if `CREDITSAFE_API_KEY` is set
 *   2. Endole if `ENDOLE_API_KEY` is set
 *   3. Mock otherwise (used in dev + tests)
 *
 * Callers should import from here, not from `../endole` or `../creditsafe` directly,
 * so swapping providers is a single env flag — no code change.
 */
import { logger } from '../../utils/logger.js';
import * as endole from '../endole/endole-client.js';
import * as creditsafe from '../creditsafe/creditsafe-client.js';
import type { CreditReport, CreditProvider } from './types.js';
import { scoreToRiskRating } from './types.js';

export type { CreditReport, CreditProvider } from './types.js';

export function getActiveProvider(): CreditProvider {
  if (creditsafe.isCreditsafeConfigured()) return 'creditsafe';
  if (endole.isEndoleConfigured()) return 'endole';
  return 'mock';
}

export async function runCreditCheck(companyNumber: string, companyName: string): Promise<CreditReport> {
  const provider = getActiveProvider();
  logger.debug({ provider, companyNumber }, 'Credit check dispatched');

  switch (provider) {
    case 'creditsafe':
      return creditsafe.runCreditCheck(companyNumber, companyName);
    case 'endole': {
      const raw = await endole.runCreditCheck(companyNumber, companyName);
      // Endole's client returns a legacy shape without `source`; stamp it.
      return { ...raw, source: 'endole' };
    }
    case 'mock':
    default:
      return mockReport(companyNumber, companyName);
  }
}

function mockReport(companyNumber: string, companyName: string): CreditReport {
  const score = Math.floor(Math.random() * 60) + 40;
  return {
    companyId: `mock-${companyNumber}`,
    companyName,
    companyNumber,
    creditScore: score,
    riskRating: scoreToRiskRating(score),
    ccjCount: score < 50 ? Math.floor(Math.random() * 3) + 1 : 0,
    ccjTotal: score < 50 ? Math.floor(Math.random() * 15000) : 0,
    registrationDate: '2018-03-15',
    checkedAt: new Date().toISOString(),
    source: 'mock',
  };
}
