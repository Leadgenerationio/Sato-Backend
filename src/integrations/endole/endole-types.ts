import type { CreditReport } from '../credit-check/types.js';

/**
 * Kept as an alias for back-compat with existing callers that still import
 * from this file. New code should import `CreditReport` from
 * `integrations/credit-check/types.ts` directly.
 */
export type EndoleCreditReport = Omit<CreditReport, 'source'>;
