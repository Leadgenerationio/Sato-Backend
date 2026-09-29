import { eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { businessSettings } from '../db/schema/business-settings.js';
import { AppError } from '../utils/errors.js';
import { VAT_TREATMENTS, type VatTreatment } from '../utils/client-locale.js';

// Sam feedback 2026-09-29 (S4): Xero tax type per VAT treatment, set by the
// Owner. Defaults are today's behaviour, so nothing changes until Sam (with
// the accountant) picks a code.
export type XeroTaxTypes = Record<VatTreatment, string>;

export const DEFAULT_XERO_TAX_TYPES: XeroTaxTypes = {
  uk_standard: 'OUTPUT2',
  uk_zero_rated: 'ZERORATEDOUTPUT',
  reverse_charge: 'NONE',
  outside_scope: 'NONE',
};

/** Xero UK system tax types offered in the picker. Custom org codes are also
 *  accepted if they look like a Xero TaxType. */
export const KNOWN_XERO_TAX_TYPES = [
  'OUTPUT2', 'ZERORATEDOUTPUT', 'EXEMPTOUTPUT', 'NONE', 'ECZROUTPUT', 'ECZROUTPUTSERVICES', 'RROUTPUT',
] as const;

const CUSTOM_CODE = /^[A-Z0-9]{2,20}$/;

export function isValidXeroTaxType(code: string): boolean {
  return (KNOWN_XERO_TAX_TYPES as readonly string[]).includes(code) || CUSTOM_CODE.test(code);
}

export async function getXeroTaxTypes(businessId: string | null | undefined): Promise<XeroTaxTypes> {
  if (!businessId) return { ...DEFAULT_XERO_TAX_TYPES };
  const [row] = await db.select({ t: businessSettings.xeroTaxTypes }).from(businessSettings).where(eq(businessSettings.businessId, businessId));
  const saved = row?.t ?? {};
  const out = { ...DEFAULT_XERO_TAX_TYPES };
  for (const k of VAT_TREATMENTS) if (typeof saved[k] === 'string' && isValidXeroTaxType(saved[k])) out[k] = saved[k];
  return out;
}

export async function setXeroTaxTypes(
  businessId: string,
  patch: Partial<Record<string, string>>,
  userId: string,
): Promise<XeroTaxTypes> {
  const clean: Partial<XeroTaxTypes> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(VAT_TREATMENTS as readonly string[]).includes(k)) throw new AppError(422, `Unknown VAT treatment "${k}".`);
    const code = String(v ?? '').trim().toUpperCase();
    if (!isValidXeroTaxType(code)) throw new AppError(422, `"${v}" isn't a valid Xero tax type. Use a code like OUTPUT2 or ECZROUTPUTSERVICES.`);
    clean[k as VatTreatment] = code;
  }
  const current = await getXeroTaxTypes(businessId);
  const next = { ...current, ...clean };
  await db
    .insert(businessSettings)
    .values({ businessId, xeroTaxTypes: next, updatedBy: userId })
    .onConflictDoUpdate({ target: businessSettings.businessId, set: { xeroTaxTypes: next, updatedBy: userId, updatedAt: sql`now()` } });
  return next;
}

/**
 * Xero tax code for one invoice. An invoice that actually charges VAT always
 * uses the standard-rate code; otherwise the client's VAT treatment decides.
 * A UK-standard client invoiced without VAT stays NONE so Xero never adds VAT
 * the Stato invoice didn't charge (M7).
 */
export function xeroTaxTypeFor(
  invoice: { vatAmount?: string | number | null; vatTreatment: VatTreatment },
  map: XeroTaxTypes,
): string {
  if (Number(invoice.vatAmount ?? 0) > 0) return map.uk_standard;
  if (invoice.vatTreatment === 'uk_standard') return 'NONE';
  return map[invoice.vatTreatment] ?? 'NONE';
}
