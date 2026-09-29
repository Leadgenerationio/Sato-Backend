/**
 * Normalise a currency code to a valid ISO-4217-shaped 3-letter uppercase
 * string, falling back when the input is malformed.
 *
 * Why this exists: Catchr writes ad_spend.currency straight from its API and
 * the historic `?? 'GBP'` guard only caught null/undefined — an empty string,
 * whitespace, or a wrong-length value flowed through. Downstream, the portal
 * feeds the value into Intl.NumberFormat({ style: 'currency' }), which throws
 * RangeError on a malformed code and crashed the managed-client dashboard
 * (2026-05-27 production incident). Use this at every boundary that ingests or
 * surfaces a currency so a bad code can never reach a formatter.
 *
 * The crash class is MALFORMED codes (empty / whitespace / wrong length /
 * non-letters). Well-formed-but-unknown 3-letter codes (e.g. 'XYZ') don't
 * throw in Intl, so they pass through — the regex is the real guard and the
 * try/catch is belt-and-suspenders.
 */
export function normalizeCurrencyCode(raw: string | null | undefined, fallback = 'GBP'): string {
  const code = (raw ?? '').trim().toUpperCase();
  const fb = (fallback ?? '').trim().toUpperCase();
  const safeFallback = /^[A-Z]{3}$/.test(fb) ? fb : 'GBP';
  if (!/^[A-Z]{3}$/.test(code)) return safeFallback;
  try {
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: code });
    return code;
  } catch {
    return safeFallback;
  }
}

/**
 * Format an amount in ITS OWN currency ("€34,860.00", "£1,200.00",
 * "CHF 500.00"). Feedback M3 (29 Sep 2026): server-built strings (emails,
 * agreement terms) hard-coded "£" regardless of the client's currency.
 * Malformed codes fall back to GBP via normalizeCurrencyCode, never throw.
 */
export function formatMoney(amount: number | string | null | undefined, currency: string | null | undefined): string {
  const n = Number(amount ?? 0);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: normalizeCurrencyCode(currency),
  }).format(Number.isFinite(n) ? n : 0);
}
