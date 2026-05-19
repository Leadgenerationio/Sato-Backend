import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { agreements } from '../db/schema/agreements.js';
import { creditChecks } from '../db/schema/credit-checks.js';
import { adSpend } from '../db/schema/ad-spend.js';
import type { AuthPayload } from '../types/index.js';

export interface LeadsByDayPoint {
  /** Short weekday label, e.g. "Mon". */
  day: string;
  /** ISO YYYY-MM-DD for cross-checking. */
  date: string;
  leads: number;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

/**
 * Daily lead totals across all clients for the last N days. Powers the
 * "Leads This Week" bar chart on the admin dashboard.
 *
 * Days with zero leads are returned as `leads: 0` so the chart never has gaps.
 */
export async function getLeadsByDay(_requester: AuthPayload, days = 7): Promise<LeadsByDayPoint[]> {
  const safeDays = Math.max(1, Math.min(90, days));
  const fromDate = isoDay(-(safeDays - 1));

  const rows = await db
    .select({
      date: leadDeliveries.deliveryDate,
      leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
    })
    .from(leadDeliveries)
    .where(gte(leadDeliveries.deliveryDate, fromDate))
    .groupBy(leadDeliveries.deliveryDate);

  const byDate = new Map(rows.map((r) => [r.date, r.leads]));
  const out: LeadsByDayPoint[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    out.push({
      day: WEEKDAY_LABELS[d.getDay()],
      date: dateStr,
      leads: byDate.get(dateStr) ?? 0,
    });
  }
  return out;
}

export interface ActivityItem {
  /** Stable id so the FE can dedupe and use as a key. */
  id: string;
  /** Display label for the actor. "System" for automated events. */
  user: string;
  /** Human-readable description, e.g. "Created invoice INV-1050 for Apex Media". */
  action: string;
  /** ISO timestamp; FE renders a relative time. */
  timestamp: string;
  /** Category — FE picks an icon from this. */
  category: 'invoice' | 'agreement' | 'credit' | 'system';
}

/**
 * Merge recent invoices, agreements, and credit checks into a single
 * chronological activity feed. Replaces the hardcoded mock the dashboard
 * was using.
 */
export async function getRecentActivity(_requester: AuthPayload, limit = 10): Promise<ActivityItem[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));

  // Pull a generous batch from each source then merge — most-recent-first.
  const [recentInvoices, recentAgreements, recentCredit] = await Promise.all([
    db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        total: invoices.total,
        currency: invoices.currency,
        createdAt: invoices.createdAt,
        clientName: clients.companyName,
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .orderBy(desc(invoices.createdAt))
      .limit(safeLimit),
    db
      .select({
        id: agreements.id,
        signedAt: agreements.signedAt,
        sentAt: agreements.sentAt,
        signerName: agreements.signerName,
        status: agreements.status,
        clientName: clients.companyName,
      })
      .from(agreements)
      .leftJoin(clients, eq(clients.id, agreements.clientId))
      .orderBy(desc(agreements.sentAt))
      .limit(safeLimit),
    db
      .select({
        id: creditChecks.id,
        creditScore: creditChecks.creditScore,
        scoreChange: creditChecks.scoreChange,
        checkedAt: creditChecks.checkedAt,
        clientName: clients.companyName,
      })
      .from(creditChecks)
      .leftJoin(clients, eq(clients.id, creditChecks.clientId))
      .orderBy(desc(creditChecks.checkedAt))
      .limit(safeLimit),
  ]);

  const items: ActivityItem[] = [];

  for (const r of recentInvoices) {
    if (!r.createdAt) continue;
    const amount = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: r.currency ?? 'GBP',
      maximumFractionDigits: 0,
    }).format(Number(r.total ?? 0));
    items.push({
      id: `inv-${r.id}`,
      user: 'System',
      action: `Invoice ${r.invoiceNumber ?? ''} created for ${r.clientName ?? 'client'} (${amount})`,
      timestamp: r.createdAt.toISOString(),
      category: 'invoice',
    });
  }

  for (const a of recentAgreements) {
    const ts = a.signedAt ?? a.sentAt;
    if (!ts) continue;
    const verb = a.signedAt ? 'signed' : 'sent';
    items.push({
      id: `agr-${a.id}`,
      user: 'System',
      action: `Agreement ${verb} — ${a.signerName ?? a.clientName ?? 'client'}`,
      timestamp: ts.toISOString(),
      category: 'agreement',
    });
  }

  for (const c of recentCredit) {
    if (!c.checkedAt) continue;
    const change = c.scoreChange ?? 0;
    const changeStr = change > 0 ? `+${change}` : change < 0 ? String(change) : '';
    const action = changeStr
      ? `Credit check: ${c.clientName ?? 'client'} score ${c.creditScore ?? '?'} (${changeStr})`
      : `Credit check: ${c.clientName ?? 'client'} score ${c.creditScore ?? '?'}`;
    items.push({
      id: `credit-${c.id}`,
      user: 'System',
      action,
      timestamp: c.checkedAt.toISOString(),
      category: 'credit',
    });
  }

  return items
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, safeLimit);
}

export interface DashboardStats {
  /**
   * All-time paid-invoice total (Xero). Stays as the lifetime headline so
   * Sam's mental model "this is what I've billed clients" is unchanged.
   */
  totalRevenue: number;
  /**
   * Trailing 90-day ad_spend (Catchr). FE labels this "Ad Spend (90d)".
   *
   * Was previously this-month-only, which over-counted Facebook because
   * spend happens before the corresponding leads convert to paid invoices
   * (~30-60 day lag). 90 days smooths the spend-billed-paid cycle so the
   * Net Profit / Margin numbers below aren't dominated by a single heavy
   * acquisition month.
   */
  totalCost: number;
  /**
   * Trailing 90-day revenue − trailing 90-day cost. Period-coherent and
   * matched to roughly one full ad-spend → invoice → paid cycle.
   */
  netProfit: number;
  /** netProfit / trailing-90d revenue × 100. Null when no revenue in window. */
  profitMargin: number;
  activeClients: number;
  /** Total campaigns with status='active' (regardless of client linkage). */
  activeCampaigns: number;
  /**
   * Campaigns that have at least one client_campaigns row — i.e. the ones
   * whose daily leads/revenue land in lead_deliveries and contribute to the
   * "Leads This Month" / per-client P&L numbers. Was previously absent;
   * "28 active campaigns" alongside "2,456 tracked leads" was confusing
   * because 26 of those campaigns are orphan LeadByte imports.
   */
  linkedCampaigns: number;
  /** sum(lead_count) for lead_deliveries in current month — tracked-to-Stato-client only. */
  leadsThisMonth: number;
  // Period-over-period deltas. Null when there's no prior-period baseline
  // to compare against (e.g. brand-new account, or last month had zero).
  // Frontend hides the trend chip when null.
  /**
   * (thisMonthRevenue − lastMonthRevenue) / lastMonthRevenue × 100.
   * Was previously (totalRevenue − lastMonthRevenue) / lastMonthRevenue which
   * compared 12-month total against 1-month figure and produced bogus +500%+
   * deltas.
   */
  revenueChange: number | null;
  leadsChange: number | null;
  /** ISO timestamp the stats were computed. Useful for "as of" labelling on the FE. */
  asOf: string;
}

/**
 * Aggregate counts and sums for the dashboard top-row KPI cards.
 *
 * Replaces the FE pattern of fetching three list endpoints with `?limit=100`
 * and summing in JS — which capped totals at 100 records and fired three
 * round-trips to render four numbers. This single endpoint runs four small
 * SQL queries server-side (each index-backed, no LIMIT cap) and returns the
 * full picture.
 *
 * Revenue / cost are sourced from `invoices` (paid) and `lead_deliveries`
 * cost respectively — same definition as the per-client P&L report.
 * leadsThisMonth is summed from `lead_deliveries.deliveryDate >= start of
 * current month`. Active clients / campaigns are simple status filters.
 */
export async function getDashboardStats(_requester: AuthPayload): Promise<DashboardStats> {
  // Start of current calendar month in YYYY-MM-DD (UTC). Postgres compares
  // string dates lexicographically when both are ISO-formatted.
  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  // Start + end of LAST calendar month for period-over-period deltas.
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthStart = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const lastMonthEnd = monthStart; // exclusive end
  // Trailing 90-day window for Net Profit / Margin. Smooths the ~30-60 day
  // lag between ad-spend (when Sam pays Facebook) and invoice-paid (when
  // his clients pay him for the leads those ads generated). Comparing
  // this-month-vs-this-month over-states spend; 90d covers ~1 full cycle.
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const ninetyDayStart = ninetyDaysAgo.toISOString().slice(0, 10);

  const [
    totalRevenueRow, costNinetyRow, clientsRow, campaignsRow, linkedCampaignsRow, thisMonthLeadsRow,
    thisMonthRevenueRow, lastMonthRevenueRow, lastMonthLeadsRow,
    revenueNinetyRow,
  ] = await Promise.all([
    // Headline number: sum of paid invoices, all-time. Stays as the lifetime
    // total in the "Total Revenue" card so the headline matches Xero's
    // running tally exactly.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(eq(invoices.status, 'paid')),
    // Cost shown on the dashboard = trailing 90-day ad-spend.
    db
      .select({ cost: sql<string>`coalesce(sum(${adSpend.spend}), 0)::text` })
      .from(adSpend)
      .where(gte(adSpend.date, ninetyDayStart)),
    // Active clients: status IN ('active', 'onboarding'). 'onboarding'
    // clients (e.g. UKESN, Benson Goldstein) are real clients being set
    // up — they ship leads and have signed/sent agreements. Excluding
    // them under-counted the widget at "1" when both should appear.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(inArray(clients.status, ['active', 'onboarding'])),
    // Active campaigns: status='active' (regardless of client linkage).
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaigns)
      .where(eq(campaigns.status, 'active')),
    // Linked campaigns: status='active' AND at least one client_campaigns
    // row. Surfaces the gap between "campaigns Sam runs on LeadByte" (28)
    // vs "campaigns whose leads + revenue flow into Stato per-client P&L"
    // (2) — without this number the dashboard implied "28 campaigns but
    // only 2,456 leads" looked like an attribution failure.
    db
      .select({ n: sql<number>`count(distinct ${campaigns.id})::int` })
      .from(campaigns)
      .innerJoin(clientCampaigns, eq(clientCampaigns.campaignId, campaigns.id))
      .where(eq(campaigns.status, 'active')),
    // Leads this month: sum of leadCount on deliveries from start of month.
    db
      .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(gte(leadDeliveries.deliveryDate, monthStart)),
    // This-month revenue: paid invoices with due_date in current calendar
    // month — same shape as last-month, so revenueChange compares like-for-like.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(sql`${invoices.status} = 'paid' AND ${invoices.dueDate} >= ${monthStart}::date`),
    // Last month revenue: paid invoices with due_date in last calendar
    // month. Was filtering by `createdAt` but every paid invoice's
    // created_at = Xero sync time (May 2026), so the last-month bucket
    // was always empty. `due_date` carries the real Xero invoice period.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(sql`${invoices.status} = 'paid' AND ${invoices.dueDate} >= ${lastMonthStart}::date AND ${invoices.dueDate} < ${lastMonthEnd}::date`),
    // Last month leads: deliveries in last calendar month.
    db
      .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(sql`${leadDeliveries.deliveryDate} >= ${lastMonthStart}::date AND ${leadDeliveries.deliveryDate} < ${lastMonthEnd}::date`),
    // Trailing 90-day revenue (paid invoices with due_date in window).
    // Pairs with the trailing 90-day ad_spend cost above so Net Profit
    // and Margin compare like-for-like over the same window.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(sql`${invoices.status} = 'paid' AND ${invoices.dueDate} >= ${ninetyDayStart}::date`),
  ]);

  // Headline (all-time) revenue.
  const totalRevenue = Number(totalRevenueRow[0]?.revenue ?? '0');
  // This-month numbers used only for the trend chip on Total Revenue.
  const thisMonthRevenue = Number(thisMonthRevenueRow[0]?.revenue ?? '0');
  // Trailing 90-day numbers used for Net Profit / Margin so the spend →
  // billed → paid lag (~30-60 days) doesn't dominate a single-month read.
  const ninetyDayRevenue = Number(revenueNinetyRow[0]?.revenue ?? '0');
  const ninetyDayCost = Number(costNinetyRow[0]?.cost ?? '0');
  const netProfit = ninetyDayRevenue - ninetyDayCost;
  const profitMargin = ninetyDayRevenue > 0
    ? Math.round((netProfit / ninetyDayRevenue) * 1000) / 10
    : 0;

  // Period-over-period deltas. Only compute when last month had a non-zero
  // baseline — avoids dividing by zero and showing nonsensical "+∞%" chips.
  // Compare LIKE-FOR-LIKE: this-month revenue vs last-month revenue. The
  // previous formula used totalRevenue (lifetime) which always blew the chip
  // out to +500-1000%.
  const lastMonthRevenue = Number(lastMonthRevenueRow[0]?.revenue ?? '0');
  const lastMonthLeads = lastMonthLeadsRow[0]?.leads ?? 0;
  const thisMonthLeads = thisMonthLeadsRow[0]?.leads ?? 0;
  const revenueChange = lastMonthRevenue > 0
    ? Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 1000) / 10
    : null;
  const leadsChange = lastMonthLeads > 0
    ? Math.round(((thisMonthLeads - lastMonthLeads) / lastMonthLeads) * 1000) / 10
    : null;

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCost: Math.round(ninetyDayCost * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    profitMargin,
    activeClients: clientsRow[0]?.n ?? 0,
    activeCampaigns: campaignsRow[0]?.n ?? 0,
    linkedCampaigns: linkedCampaignsRow[0]?.n ?? 0,
    leadsThisMonth: thisMonthLeads,
    revenueChange,
    leadsChange,
    asOf: now.toISOString(),
  };
}

void and;  // and is exported just-in-case future filters need scoping
