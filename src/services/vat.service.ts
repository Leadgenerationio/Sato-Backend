/**
 * VAT helpers — UK statutory quarters + last-quarter-end calculation.
 *
 * UK VAT quarters end:
 *   Q1: 31 Mar
 *   Q2: 30 Jun
 *   Q3: 30 Sep
 *   Q4: 31 Dec
 *
 * "End of last completed quarter" for any date = the most recent of the
 * above that is strictly before today.
 */

const QUARTER_ENDS_MMDD: Array<[number, number]> = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

/**
 * Returns the ISO date (YYYY-MM-DD) for the end of the last completed UK VAT
 * quarter, relative to `today`.
 *
 * Examples (UTC):
 *   today = 2026-04-28 → 2026-03-31
 *   today = 2026-05-15 → 2026-03-31
 *   today = 2026-07-01 → 2026-06-30
 *   today = 2026-01-05 → 2025-12-31
 */
export function lastQuarterEnd(today: Date = new Date()): string {
  const year = today.getUTCFullYear();
  const candidates: Date[] = [];
  for (let y = year - 1; y <= year; y++) {
    for (const [m, d] of QUARTER_ENDS_MMDD) {
      candidates.push(new Date(Date.UTC(y, m - 1, d)));
    }
  }
  // Most recent candidate strictly before today
  const past = candidates.filter((c) => c.getTime() < today.getTime()).sort((a, b) => b.getTime() - a.getTime());
  const pick = past[0];
  if (!pick) {
    // Defensive — shouldn't happen unless today is before 2024-12-31 in our
    // candidate window. Fall back to one year ago.
    const fallback = new Date(today);
    fallback.setUTCFullYear(today.getUTCFullYear() - 1);
    return fallback.toISOString().slice(0, 10);
  }
  return pick.toISOString().slice(0, 10);
}

/**
 * The "since" date the VAT widget tracks from = day AFTER last quarter end.
 * (Xero's TaxSummary fromDate is inclusive.)
 */
export function vatPeriodFromDate(today: Date = new Date()): string {
  const end = new Date(`${lastQuarterEnd(today)}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString().slice(0, 10);
}

export function todayIso(today: Date = new Date()): string {
  return today.toISOString().slice(0, 10);
}
