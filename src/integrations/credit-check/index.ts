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
import { AppError } from '../../utils/errors.js';
import * as endole from '../endole/endole-client.js';
import * as creditsafe from '../creditsafe/creditsafe-client.js';
import type { CreditReport, CreditProvider } from './types.js';

export type { CreditReport, CreditProvider } from './types.js';

export function getActiveProvider(): CreditProvider {
  if (creditsafe.isCreditsafeConfigured()) return 'creditsafe';
  if (endole.isEndoleConfigured()) return 'endole';
  return 'mock';
}

/**
 * Thrown when a credit check is requested but no real provider is configured.
 * Carries a stable `code` so the FE can show a specific message ("Credit
 * check provider not configured — contact admin to set Endole or Creditsafe
 * API keys") instead of a generic 500.
 */
export class CreditProviderNotConfiguredError extends AppError {
  code = 'credit_provider_not_configured';
  constructor() {
    super(
      503,
      'Credit-check provider not configured. Add ENDOLE_APP_ID + ENDOLE_APP_KEY (or CREDITSAFE_API_KEY) to enable real credit checks.',
    );
    this.name = 'CreditProviderNotConfiguredError';
  }
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
      // No real provider configured. Refuse cleanly so the user sees a
      // clear "provider not set up" message instead of fabricated random
      // scores being persisted to the DB. The previous `mockReport` path
      // generated random 40-99 numbers indistinguishable from real data
      // — that was a no-fake-data policy violation.
      throw new CreditProviderNotConfiguredError();
  }
}
