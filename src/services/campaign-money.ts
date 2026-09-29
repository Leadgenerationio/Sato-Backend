/**
 * Pure helpers behind the campaign-detail money figures (Sam S11,
 * 2026-09-29). Kept free of DB / LeadByte calls so the maths is unit-tested
 * directly — the page showed a "Supplier CPL Comparison" with no bars,
 * "facebook" and "Facebook Ads" as two sources, and "Cost £0.00" next to a
 * −£1,087.53 loss, because each figure was assembled from a different source.
 *
 * Rules:
 *   - A LeadByte supplier and a Catchr ad account that name the same ad
 *     platform are ONE source (see sourceKey in utils/catchr-platform).
 *   - Cost = what LeadByte paid out to the supplier + the Catchr ad spend of
 *     this campaign's linked accounts on that platform. For direct-traffic
 *     campaigns LeadByte's payout is 0 and the real cost is the ad spend,
 *     which is why every CPL bar used to be zero length.
 *   - A windowed "Cost" includes the ad spend for that same window, so it
 *     agrees with the profit figure next to it.
 */
import { sourceKey, sourceLabel } from '../utils/catchr-platform.js';
import type { CampaignDailyPlatformSpend } from './traffic-source-aggregation.service.js';

export type MoneyWindow =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month' | 'ytd' | 'last_30d';

const DAY_MS = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive [start, end] YYYY-MM-DD bounds for a window, on the UTC calendar
 * (ad_spend.date is a plain date written from Catchr's UTC day). Weeks start
 * on Monday, matching the campaign page's window tabs.
 */
export function windowBounds(win: MoneyWindow, now: Date = new Date()): { start: string; end: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (today.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const shift = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (win) {
    case 'today':
      return { start: ymd(today), end: ymd(today) };
    case 'yesterday':
      return { start: ymd(shift(today, -1)), end: ymd(shift(today, -1)) };
    case 'this_week':
      return { start: ymd(shift(today, -dow)), end: ymd(today) };
    case 'last_week':
      return { start: ymd(shift(today, -dow - 7)), end: ymd(shift(today, -dow - 1)) };
    case 'this_month':
      return { start: ymd(new Date(Date.UTC(y, m, 1))), end: ymd(today) };
    case 'last_month':
      // Date.UTC(y, m, 0) is the last day of the previous month — never
      // setMonth(m - 1) on "today", which overflows on the 29th–31st.
      return { start: ymd(new Date(Date.UTC(y, m - 1, 1))), end: ymd(new Date(Date.UTC(y, m, 0))) };
    case 'ytd':
      return { start: ymd(new Date(Date.UTC(y, 0, 1))), end: ymd(today) };
    case 'last_30d':
      return { start: ymd(shift(today, -30)), end: ymd(today) };
  }
}

/** Earliest date any window needs — the one `since` for a single spend query. */
export function earliestWindowStart(wins: readonly MoneyWindow[], now: Date = new Date()): string {
  return wins.map((w) => windowBounds(w, now).start).sort()[0] ?? ymd(now);
}

/** Total spend of the rows whose date falls inside [start, end]. */
export function sumSpend(
  rows: readonly CampaignDailyPlatformSpend[],
  bounds: { start: string; end: string },
  platform?: string,
): number {
  let total = 0;
  for (const r of rows) {
    if (r.date < bounds.start || r.date > bounds.end) continue;
    if (platform !== undefined && r.platform !== platform) continue;
    total += r.spend;
  }
  return Math.round(total * 100) / 100;
}

export interface SupplierInput {
  name: string;
  /** LeadByte payout to the supplier. */
  totalSpend: number;
  totalLeads: number;
  revenue: number;
}

export interface MergedSupplier {
  /** sourceKey — 'facebook-ads' for every Facebook spelling. */
  id: string;
  /** Display label ("Facebook"). */
  name: string;
  platform: string;
  /** leadbyteCost + adSpend. */
  totalSpend: number;
  /** What LeadByte paid out to the supplier(s). */
  leadbyteCost: number;
  /** Catchr spend of this campaign's linked accounts on the platform. */
  adSpend: number;
  totalLeads: number;
  revenue: number;
  /** null when there are no leads — a CPL of "£0" would be a lie. */
  cpl: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Merge LeadByte supplier rows that name the same source, and fold in the
 * campaign's Catchr ad spend per platform (same window as the supplier
 * report — last 30 days). A platform with ad spend but no LeadByte supplier
 * row still appears (0 leads, cpl null) so spend is never silently dropped.
 * Sorted by total cost, largest first.
 */
export function mergeSuppliers(
  suppliers: readonly SupplierInput[],
  adSpendByPlatform: ReadonlyMap<string, number>,
): MergedSupplier[] {
  const byKey = new Map<string, { label: string; leadbyteCost: number; leads: number; revenue: number }>();
  for (const s of suppliers) {
    const key = sourceKey(s.name);
    if (!key) continue;
    const cur = byKey.get(key) ?? { label: s.name, leadbyteCost: 0, leads: 0, revenue: 0 };
    cur.leadbyteCost += Number(s.totalSpend ?? 0);
    cur.leads += Number(s.totalLeads ?? 0);
    cur.revenue += Number(s.revenue ?? 0);
    byKey.set(key, cur);
  }
  for (const [platform, spend] of adSpendByPlatform) {
    if (spend > 0 && !byKey.has(platform)) {
      byKey.set(platform, { label: platform, leadbyteCost: 0, leads: 0, revenue: 0 });
    }
  }
  const out: MergedSupplier[] = [];
  for (const [key, v] of byKey) {
    const adSpend = round2(adSpendByPlatform.get(key) ?? 0);
    const leadbyteCost = round2(v.leadbyteCost);
    const totalSpend = round2(leadbyteCost + adSpend);
    out.push({
      id: key,
      name: sourceLabel(key, v.label),
      platform: key,
      totalSpend,
      leadbyteCost,
      adSpend,
      totalLeads: v.leads,
      revenue: round2(v.revenue),
      cpl: v.leads > 0 ? round2(totalSpend / v.leads) : null,
    });
  }
  return out.sort((a, b) => b.totalSpend - a.totalSpend || a.name.localeCompare(b.name));
}

/** Sum the rows per platform inside the bounds → Map<platform, spend>. */
export function spendByPlatform(
  rows: readonly CampaignDailyPlatformSpend[],
  bounds: { start: string; end: string },
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.date < bounds.start || r.date > bounds.end) continue;
    out.set(r.platform, (out.get(r.platform) ?? 0) + r.spend);
  }
  return out;
}
