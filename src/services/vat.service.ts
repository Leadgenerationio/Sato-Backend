/**
 * VAT helpers — UK HMRC quarter math with stagger support.
 *
 * HMRC assigns every VAT-registered business one of three quarter staggers:
 *   Stagger 1 — quarters end MAR / JUN / SEP / DEC
 *   Stagger 2 — quarters end APR / JUL / OCT / JAN   (Sam's CMS quarters)
 *   Stagger 3 — quarters end MAY / AUG / NOV / FEB
 *
 * Default is Stagger 1 (calendar quarters). Override per-org with the
 * XERO_VAT_STAGGER env var (1 / 2 / 3). Stagger isn't reliably exposed on
 * Xero's /Organisation endpoint, so config-driven is the simplest reliable
 * source of truth.
 *
 * Per Sam Loom #11 confirming CMS' quarters (Feb–Apr, May–Jul, Aug–Oct,
 * Nov–Jan), CMS is on Stagger 2 — set `XERO_VAT_STAGGER=2` in Railway.
 */

export type VatStagger = 1 | 2 | 3;

/**
 * Month numbers (1-12) on which each stagger's quarters END. Used to compute
 * the most-recently-closed quarter and the current open quarter.
 */
const STAGGER_END_MONTHS: Record<VatStagger, number[]> = {
  1: [3, 6, 9, 12],
  2: [4, 7, 10, 1],
  3: [5, 8, 11, 2],
};

export function configuredStagger(env: NodeJS.ProcessEnv = process.env): VatStagger {
  const raw = env.XERO_VAT_STAGGER;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  return 1;
}

export interface QuarterRange {
  /** Inclusive YYYY-MM-DD */
  fromDate: string;
  /** Inclusive YYYY-MM-DD */
  toDate: string;
}

function lastDayOfMonth(year: number, monthIdx0: number): number {
  // Day 0 of next month = last day of this month
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).getUTCDate();
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Enumerate quarter END dates (year, month-1-12, day) for the given stagger
 * across [today.year-1, today.year+1] so any nearby today resolves cleanly.
 */
function enumerateQuarterEnds(today: Date, stagger: VatStagger): Date[] {
  const endMonths = STAGGER_END_MONTHS[stagger];
  const year = today.getUTCFullYear();
  const ends: Date[] = [];
  for (let y = year - 1; y <= year + 1; y++) {
    for (const m of endMonths) {
      const day = lastDayOfMonth(y, m - 1);
      ends.push(new Date(Date.UTC(y, m - 1, day)));
    }
  }
  return ends.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The most-recently-closed VAT quarter on the given stagger. "Closed" means
 * the quarter whose end date is strictly before today.
 */
export function previousQuarter(
  today: Date = new Date(),
  stagger: VatStagger = configuredStagger(),
): QuarterRange {
  const ends = enumerateQuarterEnds(today, stagger);
  const pastEnds = ends.filter((d) => d.getTime() < today.getTime());
  const end = pastEnds[pastEnds.length - 1] ?? ends[0];
  const endIdx = ends.indexOf(end);
  const prevEnd = ends[endIdx - 1];
  // Quarter start = day after the previous end. If there's no prev end in
  // window (edge case), use the canonical 3-months-back-plus-1-day.
  const start = prevEnd
    ? new Date(prevEnd.getTime() + 86_400_000)
    : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  return { fromDate: iso(start), toDate: iso(end) };
}

/**
 * The current open VAT quarter — from the day after the previous quarter
 * ended through `today` (today is the live accrual cut-off).
 */
export function currentQuarter(
  today: Date = new Date(),
  stagger: VatStagger = configuredStagger(),
): QuarterRange {
  const prev = previousQuarter(today, stagger);
  const startMs = new Date(`${prev.toDate}T00:00:00Z`).getTime() + 86_400_000;
  return { fromDate: iso(new Date(startMs)), toDate: iso(today) };
}

export function todayIso(today: Date = new Date()): string {
  return iso(today);
}

// ─── Labelled wrappers (kept for callers that want a human-readable label) ──

export interface VatQuarterRange extends QuarterRange {
  label: string; // e.g. "Feb–Apr 2026"
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelRange(fromIso: string, toIso: string): string {
  const f = new Date(`${fromIso}T00:00:00Z`);
  const t = new Date(`${toIso}T00:00:00Z`);
  return `${MONTH_NAMES[f.getUTCMonth()]}–${MONTH_NAMES[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** Today's open quarter, with display label. */
export function currentQuarterRange(today: Date = new Date()): VatQuarterRange {
  const r = currentQuarter(today);
  return { ...r, label: labelRange(r.fromDate, r.toDate) };
}

/** Most recently completed quarter, with display label. */
export function lastCompletedQuarterRange(today: Date = new Date()): VatQuarterRange {
  const r = previousQuarter(today);
  return { ...r, label: labelRange(r.fromDate, r.toDate) };
}

/**
 * Back-compat shim — returns just the end date of the last-completed quarter.
 * Kept so older callers / tests that don't need the full range still compile.
 */
export function lastQuarterEnd(today: Date = new Date()): string {
  return previousQuarter(today).toDate;
}

/**
 * Sam Loom #12 — VAT submissions history. Returns the previous N closed
 * quarters in newest-first order (excluding the most-recent one, which the
 * existing widget already shows as "Due to HMRC").
 *
 * Used by the VAT widget "Past quarters" expandable section so Sam can see
 * how much VAT he's filed in prior quarters without leaving Stato.
 */
export function historicalQuarters(
  count: number,
  today: Date = new Date(),
  stagger: VatStagger = configuredStagger(),
): VatQuarterRange[] {
  if (count <= 0) return [];
  const ends = enumerateQuarterEnds(today, stagger);
  const past = ends.filter((d) => d.getTime() < today.getTime()).sort((a, b) => b.getTime() - a.getTime());

  // index 0 of `past` is the most recent closed quarter — that's already the
  // "Due to HMRC" block, so skip it and start from index 1.
  const ranges: VatQuarterRange[] = [];
  for (let i = 1; i <= count && i < past.length; i++) {
    const end = past[i];
    const prevEnd = past[i + 1];
    const start = prevEnd
      ? new Date(prevEnd.getTime() + 86_400_000)
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
    const fromDate = iso(start);
    const toDate = iso(end);
    ranges.push({ fromDate, toDate, label: labelRange(fromDate, toDate) });
  }
  return ranges;
}
