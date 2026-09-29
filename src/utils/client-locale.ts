// Sam feedback 2026-09-29 (M5 / S4): non-UK clients couldn't be set up
// properly — one VAT tick drove both "VAT registered" and "add VAT to
// invoices", and nothing checked phone / postcode input ("not-a-phone ###",
// "!!!!!!!!" went straight to the DB).
//
// The FE does the country-aware checks (prefix must match the country, local
// postcode formats). The server-side checks here are deliberately lenient —
// they only reject input that can't be a phone number or postcode anywhere,
// so a country we don't have a format for still saves.

export const VAT_TREATMENTS = ['uk_standard', 'uk_zero_rated', 'reverse_charge', 'outside_scope'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/**
 * Legacy boolean pair written alongside vat_treatment so older readers
 * (invoice detail `vatRegistered`, portal, Xero probes) keep a consistent
 * picture. vat_registered = "the client has a VAT registration we invoice
 * against" — true for zero-rated and reverse-charge B2B too; only
 * add_vat_to_invoices decides whether a VAT line is charged.
 */
export function vatFlagsFor(treatment: VatTreatment): { vatRegistered: boolean; addVatToInvoices: boolean } {
  switch (treatment) {
    case 'uk_standard': return { vatRegistered: true, addVatToInvoices: true };
    case 'uk_zero_rated': return { vatRegistered: true, addVatToInvoices: false };
    case 'reverse_charge': return { vatRegistered: true, addVatToInvoices: false };
    case 'outside_scope': return { vatRegistered: false, addVatToInvoices: false };
  }
}

/**
 * Treatment for a row that predates the vat_treatment column (or was written
 * by a caller that only sent the legacy booleans). Mirrors the 0040 backfill
 * and keeps today's invoice behaviour: VAT was being added → standard UK VAT;
 * registered but no VAT added → zero-rated; neither → outside scope.
 */
export function deriveVatTreatment(
  stored: string | null | undefined,
  addVatToInvoices: boolean | null | undefined,
  vatRegistered: boolean | null | undefined,
): VatTreatment {
  if (stored && (VAT_TREATMENTS as readonly string[]).includes(stored)) return stored as VatTreatment;
  if (addVatToInvoices) return 'uk_standard';
  return vatRegistered ? 'uk_zero_rated' : 'outside_scope';
}

/** Only standard-rated UK VAT puts a VAT line on the invoice. */
export function treatmentChargesVat(treatment: VatTreatment): boolean {
  return treatment === 'uk_standard';
}

/**
 * Plausible phone number anywhere: digits plus the usual separators, 7–15
 * digits (E.164 max). Empty is allowed — phone is optional.
 */
export function isPlausiblePhone(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim();
  if (v === '') return true;
  if (!/^\+?[\d\s().-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

/**
 * Plausible postcode anywhere: letters, digits, spaces and hyphens, 2–10
 * characters, starting and ending with a letter or digit. Empty is allowed (some
 * countries, e.g. UAE, have no postcodes).
 */
export function isPlausiblePostcode(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim();
  if (v === '') return true;
  return /^[A-Za-z0-9][A-Za-z0-9 -]{0,8}[A-Za-z0-9]$/.test(v);
}

/** UK (or unset, the historical default) — the only place Endole/Creditsafe can look a company up. */
export function isUkCountry(country: string | null | undefined): boolean {
  const v = (country ?? '').trim().toLowerCase();
  return v === '' || ['united kingdom', 'uk', 'gb', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'].includes(v);
}

/** Trim a string field; undefined/null pass through untouched so "not sent" stays "not sent". */
export function trimOrKeep<T extends string | null | undefined>(v: T): T {
  return (typeof v === 'string' ? v.trim() : v) as T;
}
