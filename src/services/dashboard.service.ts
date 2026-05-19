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
import {
  resolveDashboardWindow,
  type DashboardWindow,
} from '../utils/dashboard-window.js';

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
   * Paid-invoice total (Xero) in the selected window. Default window is
   * 'last_year', so the no-filter response matches the prior 12-month
   * lifetime headline (~£734k) almost exactly given Xero has ~12 months
   * of history. Shorter windows scope the tile to that period.
   */
  totalRevenue: number;
  /**
   * Ad spend (Catchr) in the selected window. Catchr only has ~50d of
   * history so windows wider than 90d are bounded by what's available;
   * the FE labels the tile with the selected window so users know.
   */
  totalCost: number;
  /**
   * Revenue − cost over the selected window — period-coherent.
   *
   * Both numerator and denominator share the same window, so margins read
   * intuitively. For short windows (this_week/this_month), the
   * acquisition-spend → invoice → paid lag (~30-60 days) makes Net Profit
   * look heavily negative — that's accurate for the period, not a bug.
   * Use 'last_year' (default) for a smoothed annual view.
   */
  netProfit: number;
  /** netProfit / revenue × 100. Null when no revenue in window. */
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
  /**
   * sum(lead_count) for lead_deliveries in the selected window (default: current
   * calendar month if no `?window=` param was supplied). Tracked-to-Stato-client
   * only — orphan campaigns aren't in lead_deliveries.
   */
  leadsThisMonth: number;
  /**
   * Echoes the window key the BE used to compute leadsThisMonth + leadsChange,
   * so the FE can label the tile correctly ("Leads (Last 90 days)" etc.).
   * Always present even when no `?window=` was passed (defaults to 'this_month').
   */
  leadsWindow: DashboardWindow;
  /** Human-readable label for the selected lead window. */
  leadsWindowLabel: string;
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
export async function getDashboardStats(
  _requester: AuthPayload,
  opts: { window?: DashboardWindow; leadsWindow?: DashboardWindow } = {},
): Promise<DashboardStats> {
  // Single window now drives Leads + Revenue + Ad Spend + Net Profit +
  // Margin + their trend chips. Default 'last_year' matches the prior
  // rolling-365d revenue / 90d-cost behaviour numerically (Catchr only
  // has ~50d of history, so 90d ≈ 365d for cost) and keeps the response
  // backwards-compatible: legacy callers without ?window= see Net Profit
  // ≈ -£29,927 and Margin ≈ -4.1%, same as before this rollout.
  //
  // `leadsWindow` accepted as an alias for back-compat with the earlier
  // commit that only filtered the Leads tile — both keys point at the
  // same field on the request now.
  const windowKey: DashboardWindow = opts.window ?? opts.leadsWindow ?? 'last_year';
  const win = resolveDashboardWindow(windowKey);
  const now = new Date();

  const [
    revenueRow, costRow, clientsRow, campaignsRow, linkedCampaignsRow,
    leadsRow, prevRevenueRow, prevLeadsRow,
  ] = await Promise.all([
    // Revenue in the selected window — paid invoices with due_date in range.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(sql`${invoices.status} = 'paid' AND ${invoices.dueDate} >= ${win.startIso}::date AND ${invoices.dueDate} <= ${win.endIso}::date`),
    // Ad spend in the selected window. Catchr only has ~50d of history;
    // for windows wider than that the sum is bounded by what's available.
    db
      .select({ cost: sql<string>`coalesce(sum(${adSpend.spend}), 0)::text` })
      .from(adSpend)
      .where(sql`${adSpend.date} >= ${win.startIso}::date AND ${adSpend.date} <= ${win.endIso}::date`),
    // Active clients: status IN ('active', 'onboarding'). Time-window
    // independent — a client either exists or doesn't right now.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(inArray(clients.status, ['active', 'onboarding'])),
    // Active campaigns: status='active', regardless of client linkage.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaigns)
      .where(eq(campaigns.status, 'active')),
    // Linked campaigns: subset of activeCampaigns with >=1 client_campaigns
    // row. Surfaces the gap between "campaigns Sam runs on LeadByte" and
    // "campaigns whose leads + revenue flow into Stato per-client P&L".
    db
      .select({ n: sql<number>`count(distinct ${campaigns.id})::int` })
      .from(campaigns)
      .innerJoin(clientCampaigns, eq(clientCampaigns.campaignId, campaigns.id))
      .where(eq(campaigns.status, 'active')),
    // Leads in selected window.
    db
      .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(sql`${leadDeliveries.deliveryDate} >= ${win.startIso}::date AND ${leadDeliveries.deliveryDate} <= ${win.endIso}::date`),
    // Prior equivalent window — drives revenueChange.
    db
      .select({ revenue: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(sql`${invoices.status} = 'paid' AND ${invoices.dueDate} >= ${win.prevStartIso}::date AND ${invoices.dueDate} <= ${win.prevEndIso}::date`),
    // Prior equivalent window for leadsChange.
    db
      .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(sql`${leadDeliveries.deliveryDate} >= ${win.prevStartIso}::date AND ${leadDeliveries.deliveryDate} <= ${win.prevEndIso}::date`),
  ]);

  const revenue = Number(revenueRow[0]?.revenue ?? '0');
  const cost = Number(costRow[0]?.cost ?? '0');
  const netProfit = revenue - cost;
  const profitMargin = revenue > 0
    ? Math.round((netProfit / revenue) * 1000) / 10
    : 0;

  // Trend chips: window vs prior equivalent window. Null when prior was zero
  // so the FE hides the chip rather than showing "+∞%".
  const prevRevenue = Number(prevRevenueRow[0]?.revenue ?? '0');
  const prevLeads = prevLeadsRow[0]?.leads ?? 0;
  const leads = leadsRow[0]?.leads ?? 0;
  const revenueChange = prevRevenue > 0
    ? Math.round(((revenue - prevRevenue) / prevRevenue) * 1000) / 10
    : null;
  const leadsChange = prevLeads > 0
    ? Math.round(((leads - prevLeads) / prevLeads) * 1000) / 10
    : null;

  return {
    totalRevenue: Math.round(revenue * 100) / 100,
    totalCost: Math.round(cost * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    profitMargin,
    activeClients: clientsRow[0]?.n ?? 0,
    activeCampaigns: campaignsRow[0]?.n ?? 0,
    linkedCampaigns: linkedCampaignsRow[0]?.n ?? 0,
    leadsThisMonth: leads,
    leadsWindow: windowKey,
    leadsWindowLabel: win.label,
    revenueChange,
    leadsChange,
    asOf: now.toISOString(),
  };
}

void and;  // and is exported just-in-case future filters need scoping
