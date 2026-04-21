import { logger } from '../../utils/logger.js';
import type { EndoleCreditReport } from './endole-types.js';

function isConfigured(): boolean {
  return !!(process.env.ENDOLE_API_KEY);
}

export function isEndoleConfigured(): boolean {
  return isConfigured();
}

export async function runCreditCheck(companyNumber: string, companyName: string): Promise<EndoleCreditReport> {
  if (!isConfigured()) {
    logger.warn('Endole running in MOCK mode — no ENDOLE_API_KEY configured');
  }

  // Mock credit check with realistic data
  const score = Math.floor(Math.random() * 60) + 40; // 40-100
  const riskRatings: EndoleCreditReport['riskRating'][] = ['very_low', 'low', 'moderate', 'high', 'very_high'];
  let riskRating: EndoleCreditReport['riskRating'];
  if (score >= 80) riskRating = 'very_low';
  else if (score >= 65) riskRating = 'low';
  else if (score >= 50) riskRating = 'moderate';
  else if (score >= 35) riskRating = 'high';
  else riskRating = 'very_high';

  return {
    companyId: `endole-${companyNumber}`,
    companyName,
    companyNumber,
    creditScore: score,
    riskRating,
    ccjCount: score < 50 ? Math.floor(Math.random() * 3) + 1 : 0,
    ccjTotal: score < 50 ? Math.floor(Math.random() * 15000) : 0,
    registrationDate: '2018-03-15',
    checkedAt: new Date().toISOString(),
  };
}
