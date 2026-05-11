/**
 * VAT helpers — Sam Loom (#11) confirmed Clinical Marketing Solutions' VAT
 * quarters end on the last day of Apr / Jul / Oct / Jan (not the HMRC default
 * Mar/Jun/Sep/Dec). UK VAT quarters are determined at company-VAT-registration
 * time and stay fixed per business. For Phase 1 (leadgeneration.io only) we
 * hardcode CMS's quarters; if Stato grows to multiple tenants this becomes a
 * per-business setting.
 *
 * CMS quarters:
 *   Q ending 30 Apr → covers Feb–Apr   (Sam's "Feb, March, April")
 *   Q ending 31 Jul → covers May–Jul   (Sam's "May, June, July")
 *   Q ending 31 Oct → covers Aug–Oct
 *   Q ending 31 Jan → covers Nov–Jan   (crosses calendar year)
 */

const QUARTER_ENDS_MMDD: Array<[number, number]> = [
  [4, 30],
  [7, 31],
  [10, 31],
  [1, 31],
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

export interface VatQuarterRange {
  fromDate: string;       // inclusive ISO YYYY-MM-DD
  toDate: string;         // inclusive ISO YYYY-MM-DD
  label: string;          // e.g. "Feb–Apr 2026"
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(fromIso: string, toIso: string): string {
  const f = new Date(`${fromIso}T00:00:00Z`);
  const t = new Date(`${toIso}T00:00:00Z`);
  return `${MONTH_NAMES[f.getUTCMonth()]}–${MONTH_NAMES[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/**
 * The currently-running VAT quarter. fromDate is the first day of the
 * quarter; toDate is today (cap of the quarter end).
 */
export function currentQuarterRange(today: Date = new Date()): VatQuarterRange {
  const lastEnd = new Date(`${lastQuarterEnd(today)}T00:00:00Z`);
  const fromDate = new Date(lastEnd);
  fromDate.setUTCDate(fromDate.getUTCDate() + 1);
  const fromIso = fromDate.toISOString().slice(0, 10);
  const toIso = todayIso(today);
  return { fromDate: fromIso, toDate: toIso, label: label(fromIso, toIso) };
}

/**
 * The most recently completed VAT quarter (Sam's "past quarter due" value).
 * Returns the full quarter date range — Feb 1 → Apr 30 for the CMS Feb-Apr
 * quarter, for example.
 */
export function lastCompletedQuarterRange(today: Date = new Date()): VatQuarterRange {
  const end = new Date(`${lastQuarterEnd(today)}T00:00:00Z`);
  const toIso = end.toISOString().slice(0, 10);
  // Start of last quarter = end-of-quarter-before + 1 day. We can derive it
  // by computing lastQuarterEnd as of "the day before last quarter ended"
  // and adding 1, but it's clearer to walk the table directly.
  // For each quarter end, the quarter started ~3 months earlier on the 1st.
  const startMonth = (end.getUTCMonth() + 12 - 2) % 12;
  const startYearOffset = end.getUTCMonth() < 2 ? -1 : 0;
  const startYear = end.getUTCFullYear() + startYearOffset;
  const fromDate = new Date(Date.UTC(startYear, startMonth, 1));
  const fromIso = fromDate.toISOString().slice(0, 10);
  return { fromDate: fromIso, toDate: toIso, label: label(fromIso, toIso) };
}
