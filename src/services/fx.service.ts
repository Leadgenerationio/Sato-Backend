// Feedback M3 (Sam, 29 Sep 2026): "Only add amounts together after converting
// them to £, and say that they were converted (with the rate and date)."
//
// Daily ECB reference rates, stored with base GBP (1 GBP = `rate` × quote).
// Primary source: Frankfurter (ECB data, already cross-rated to GBP).
// Fallback: the ECB's own eurofxref-daily.xml (EUR base → cross via GBP).
// No credentials, no cost. If neither source is reachable and nothing is
// stored, conversion returns null and the UI keeps per-currency figures only.
import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { fxRates } from '../db/schema/index.js';
import { logger } from '../utils/logger.js';

export const FX_BASE = 'GBP';
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=GBP';
const ECB_XML_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export interface FxQuote { quote: string; rate: number }
export interface FxSnapshot { rateDate: string; source: string; quotes: FxQuote[] }
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Frankfurter `{ base: 'GBP', date: 'YYYY-MM-DD', rates: { EUR: 1.16, … } }`. */
export function parseFrankfurter(body: unknown): FxSnapshot {
  const b = body as { base?: string; date?: string; rates?: Record<string, number> };
  if (b?.base !== FX_BASE || !b.date || !b.rates || typeof b.rates !== 'object') {
    throw new Error('Unexpected Frankfurter response');
  }
  const quotes = Object.entries(b.rates)
    .filter(([q, r]) => /^[A-Z]{3}$/.test(q) && Number.isFinite(r) && r > 0)
    .map(([quote, rate]) => ({ quote, rate }));
  if (!quotes.length) throw new Error('Frankfurter response had no rates');
  return { rateDate: b.date, source: 'ECB via Frankfurter', quotes };
}

/**
 * ECB eurofxref-daily.xml: EUR-based `<Cube currency="GBP" rate="0.8412"/>`.
 * Cross to GBP base: 1 GBP = (EUR→Q) / (EUR→GBP) Q, and 1 GBP = 1/(EUR→GBP) EUR.
 */
export function parseEcbXml(xml: string): FxSnapshot {
  const date = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const eur: Record<string, number> = {};
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    eur[m[1]!] = Number(m[2]);
  }
  const eurGbp = eur.GBP;
  if (!date || !eurGbp || !(eurGbp > 0)) throw new Error('Unexpected ECB XML');
  const quotes: FxQuote[] = [{ quote: 'EUR', rate: 1 / eurGbp }];
  for (const [q, r] of Object.entries(eur)) {
    if (q === 'GBP' || !(r > 0)) continue;
    quotes.push({ quote: q, rate: r / eurGbp });
  }
  return { rateDate: date, source: 'ECB', quotes };
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms = 8000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); } finally { clearTimeout(t); }
}

/** Fetch today's rates: Frankfurter first, ECB XML if that fails. */
export async function fetchLatestRates(fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<FxSnapshot> {
  try {
    return await withTimeout(async (signal) => {
      const res = await fetchImpl(FRANKFURTER_URL, { signal });
      if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
      return parseFrankfurter(await res.json());
    });
  } catch (err) {
    logger.warn({ err }, 'FX: Frankfurter failed — falling back to ECB XML');
    return withTimeout(async (signal) => {
      const res = await fetchImpl(ECB_XML_URL, { signal });
      if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
      return parseEcbXml(await res.text());
    });
  }
}

export async function storeSnapshot(snap: FxSnapshot): Promise<number> {
  const rows = snap.quotes.map((q) => ({
    base: FX_BASE, quote: q.quote, rate: q.rate.toFixed(8), rateDate: snap.rateDate, source: snap.source,
  }));
  if (!rows.length) return 0;
  await db.insert(fxRates).values(rows).onConflictDoNothing();
  return rows.length;
}

/** Daily job body (and on-demand refresh). Never throws — logs and returns. */
export async function refreshFxRates(fetchImpl?: FetchLike): Promise<{ stored: number; rateDate?: string; source?: string; error?: string }> {
  try {
    const snap = await fetchLatestRates(fetchImpl);
    const stored = await storeSnapshot(snap);
    lastRefreshAttempt = Date.now();
    return { stored, rateDate: snap.rateDate, source: snap.source };
  } catch (err) {
    lastRefreshAttempt = Date.now();
    logger.warn({ err }, 'FX: could not refresh rates — conversions use the latest stored rates, or none');
    return { stored: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// On-demand refresh is throttled so a dashboard load never waits on the
// network more than once an hour when the sources are down.
let lastRefreshAttempt = 0;
const REFRESH_THROTTLE_MS = 60 * 60 * 1000;
export function __resetFxThrottleForTests() { lastRefreshAttempt = 0; }

export interface RateUsed { currency: string; rate: number; rateDate: string; source: string }

/** Latest stored rate on/before `onDate` (YYYY-MM-DD; default today). 1 GBP = rate × currency. */
export async function getRate(currency: string, onDate?: string): Promise<RateUsed | null> {
  const cur = currency.toUpperCase();
  if (cur === FX_BASE) return { currency: cur, rate: 1, rateDate: onDate ?? new Date().toISOString().slice(0, 10), source: 'identity' };
  const day = onDate ?? new Date().toISOString().slice(0, 10);
  const find = () => db.select().from(fxRates)
    .where(and(eq(fxRates.base, FX_BASE), eq(fxRates.quote, cur), lte(fxRates.rateDate, day)))
    .orderBy(desc(fxRates.rateDate)).limit(1);
  let [row] = await find();
  // Nothing stored yet (fresh deploy) → fetch once, on demand.
  if (!row && !onDate && Date.now() - lastRefreshAttempt > REFRESH_THROTTLE_MS && process.env.NODE_ENV !== 'test') {
    await refreshFxRates();
    [row] = await find();
  }
  if (!row) return null;
  return { currency: cur, rate: Number(row.rate), rateDate: String(row.rateDate), source: row.source };
}

/** amount (in `currency`) → GBP, or null if no rate is known. */
export async function convertToGbp(amount: number, currency: string, onDate?: string): Promise<{ gbp: number; rate: RateUsed } | null> {
  const rate = await getRate(currency, onDate);
  if (!rate) return null;
  return { gbp: Math.round((amount / rate.rate) * 100) / 100, rate };
}

export interface ConvertedTotal {
  /** Everything converted to GBP and summed. */
  amount: number;
  currency: 'GBP';
  /** Rates used, one per non-GBP currency. Always shown next to the figure. */
  rates: RateUsed[];
  /** Per-currency input, so the UI can show "£X incl. €Y converted". */
  parts: Array<{ currency: string; total: number; gbp: number }>;
}

/**
 * Sum per-currency totals as GBP. Returns null when ANY currency has no rate
 * — a partial conversion would be a silent under-count, which is exactly the
 * M3 bug. Returns null for a GBP-only list too (nothing was converted).
 */
export async function convertTotalsToGbp(totals: Array<{ currency: string; total: number | string }>): Promise<ConvertedTotal | null> {
  const clean = totals.map((t) => ({ currency: (t.currency || FX_BASE).toUpperCase(), total: Number(t.total) || 0 }));
  if (!clean.some((t) => t.currency !== FX_BASE && t.total !== 0)) return null;
  const parts: ConvertedTotal['parts'] = [];
  const rates: RateUsed[] = [];
  for (const t of clean) {
    const c = await convertToGbp(t.total, t.currency);
    if (!c) return null;
    parts.push({ currency: t.currency, total: t.total, gbp: c.gbp });
    if (t.currency !== FX_BASE) rates.push(c.rate);
  }
  const amount = Math.round(parts.reduce((s, p) => s + p.gbp, 0) * 100) / 100;
  return { amount, currency: 'GBP', rates, parts };
}
