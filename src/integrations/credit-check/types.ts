/**
 * Provider-neutral credit report shape. Endole and Creditsafe both return this
 * after their own normaliser runs. `client.service.ts` and downstream UI only
 * consume this type — they don't care which provider produced it.
 */
export interface CreditReport {
  companyId: string;
  companyName: string;
  companyNumber: string;
  creditScore: number;
  riskRating: 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
  ccjCount: number;
  ccjTotal: number;
  registrationDate: string;
  checkedAt: string;
  /** Which provider produced this report. Useful for audit + troubleshooting. */
  source: 'endole' | 'creditsafe' | 'mock';
}

export type CreditProvider = 'endole' | 'creditsafe' | 'mock';

/**
 * Map a 0-100 score to a 5-band risk rating. Boundary chosen to match our
 * existing Endole mock so frontend visuals don't shift when the provider swaps.
 */
export function scoreToRiskRating(score: number): CreditReport['riskRating'] {
  if (score >= 80) return 'very_low';
  if (score >= 65) return 'low';
  if (score >= 50) return 'moderate';
  if (score >= 35) return 'high';
  return 'very_high';
}
