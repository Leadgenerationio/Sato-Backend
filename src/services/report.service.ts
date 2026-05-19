import { and, eq, sql, isNull, gte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { clients } from '../db/schema/clients.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import type { AuthPayload } from '../types/index.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';

export interface CampaignReportRow {
  campaignId: string;
  campaignName: string;
  clientName: string;
  vertical: string;
  leads: number;
  validLeads: number;
  cost: number;
  revenue: number;
  cpl: number;
  profit: number;
  margin: number;
}

export interface ClientPnlRow {
  clientId: string;
  clientName: string;
  month: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
  leadsDelivered: number;
}

// Slice 4 Day 1 (Sam Loom #72-85): the unified leadreports.io row.
// One row per (campaign × supplier). Revenue and profit are computed by
// allocating campaign-level revenue across suppliers using their share of
// total leads — so the row math matches what Sam sees on leadreports.io:
//
//   row.revenue = campaign.totalRevenue × (supplierLeads / campaignLeads)
//   row.profit  = row.revenue − row.spend
//   row.cpl     = row.spend / row.leads
//   row.margin  = (row.revenue − row.spend) / row.revenue × 100
//
// `catchrUrl` is enriched from our `traffic_sources` table when a Sato-side
// mapping exists for that (campaign, supplier) pair — null otherwise.
export interface UnifiedReportRow {
  campaignId: string;
  campaignName: string;
  clientName: string;
  vertical: string;
  supplier: string;
  supplierPlatform: string;
  catchrUrl: string | null;
  leads: number;
  spend: number;
  revenue: number;
  profit: number;
  cpl: number;
  margin: number;
}

export interface UnifiedReportTotals {
  leads: number;
  spend: number;
  revenue: number;
  profit: number;
  margin: number;
}

export interface UnifiedReport {
  rows: UnifiedReportRow[];
  totals: UnifiedReportTotals;
}

export interface SupplierReportRow {
  supplierId: string;
  supplierName: string;
  platform: string;
  totalSpend: number;
  totalLeads: number;
  cpl: number;
  campaigns: number;
}

export interface FinancialOverviewRow {
  month: string;
  revenue: number;
  /**
   * Sum of ad_spend.spend for the month. `null` (not 0) for months that
   * predate the Catchr connection — distinguishes "we have no data here"
   * from "Sam genuinely spent £0". Charts should leave a gap on null
   * months instead of drawing a flat-zero line that misleads the eye.
   */
  expenses: number | null;
  /** revenue - expenses (or just revenue when expenses is null). */
  profit: number;
  invoicesPaid: number;
  invoicesOverdue: number;
  /** Invoices that are neither paid nor overdue — i.e. drafts + sent + due-but-not-late. */
  invoicesPending: number;
  vatCollected: number;
  /**
   * True for the current calendar month (which is always incomplete until
   * month-end). Charts can dash-stroke / fade it so users don't read the
   * partial total as a real month-over-month drop.
   */
  isPartial: boolean;
}

// Mock generators removed by policy: no fabricated data anywhere. Each
// report endpoint queries real DB / LeadByte and returns an empty array
// when there's nothing to show — UI renders "No data available".

/**
 * Build a name → {clientName, vertical} map from the real `campaigns` table
 * (synced from LeadByte). LeadByte's report rows are keyed by campaign NAME,
 * so we look up by name rather than by id. Falls back to 'Unknown' when a
 * report row doesn't have a matching synced campaign yet.
 *
 * Replaces a previous hardcoded `CAMPAIGN_META` map that pre-dated LeadByte
 * sync — real LeadByte campaign names never matched those keys, so every
 * report row showed clientName='Unknown'/vertical='Unknown' in production.
 */
/**
 * Best-effort vertical guess from campaign name when the synced campaign row
 * has no vertical column populated. Looks for keywords in the name —
 * "Hearing Aids", "Solar", "Insulation", etc. Falls back to 'Other' if no
 * keyword matches. Replaces showing "Unmapped" everywhere.
 */
function deriveVerticalFromName(name: string): string {
  const lower = name.toLowerCase();
  // Order matters — more specific phrases first so they match before generics.
  const keywords: Array<{ match: string | RegExp; label: string }> = [
    { match: 'hearing aid', label: 'Hearing Aids' },
    { match: 'solar', label: 'Solar' },
    { match: 'insulation', label: 'Insulation' },
    { match: 'lasting power of attorney', label: 'Legal — LPA' },
    { match: 'pcp claim', label: 'PCP Claims' },
    { match: 'tax claim', label: 'Tax Claims' },
    { match: 'will writ', label: 'Will Writing' },
    { match: 'mortgage', label: 'Mortgage' },
    { match: 'life insurance', label: 'Life Insurance' },
    { match: 'home insurance', label: 'Home Insurance' },
    { match: 'pmi', label: 'Private Medical Insurance' },
    { match: 'house sale', label: 'Property Sales' },
    { match: 'property sale', label: 'Property Sales' },
    { match: 'boiler', label: 'Boiler' },
    { match: 'debt', label: 'Debt Management' },
    { match: 'personal injury', label: 'Personal Injury' },
  ];
  for (const k of keywords) {
    if (typeof k.match === 'string' ? lower.includes(k.match) : k.match.test(lower)) {
      return k.label;
    }
  }
  return 'Other';
}

async function loadCampaignMetaByName(): Promise<Map<string, { clientName: string; vertical: string }>> {
  const rows = await db
    .select({
      name: campaignsTable.name,
      vertical: campaignsTable.vertical,
      clientName: clients.companyName,
    })
    .from(campaignsTable)
    .leftJoin(clients, eq(campaignsTable.clientId, clients.id));
  const map = new Map<string, { clientName: string; vertical: string }>();
  for (const r of rows) {
    if (!r.name) continue;
    map.set(r.name, {
      // clientName stays "Unmapped" until Sam delivers the LeadByte→client
      // CSV — we genuinely don't know which client owns each campaign.
      clientName: r.clientName ?? 'Pending client mapping',
      // Vertical, however, can be derived from the campaign name itself
      // ("Hearing Aids (PL)" → Hearing Aids). Falls back to derived even
      // when the synced row exists but has no vertical column.
      vertical: r.vertical && r.vertical !== 'Unmapped'
        ? r.vertical
        : deriveVerticalFromName(r.name),
    });
  }
  return map;
}

// ─── Service ───

export async function getCampaignPerformance(
  _requester: AuthPayload,
  window: DeliveryWindow = 'this_month',
): Promise<CampaignReportRow[]> {
  const [rows, metaByName] = await Promise.all([
    leadbyte.getCampaignReport(window),
    loadCampaignMetaByName(),
  ]);

  // Empty when LeadByte returns nothing for the window — the UI shows an
  // empty state. Previously fell back to a mock generator which displayed
  // fabricated revenue figures; that's been removed so users never see
  // numbers that aren't real.
  if (rows.length === 0) return [];

  return rows.map((r): CampaignReportRow => {
    // If the synced campaign row exists, use its meta; otherwise derive
    // vertical from the LeadByte campaign name itself. Client stays
    // "Unmapped" until Sam's CSV arrives.
    const meta = metaByName.get(r.campaign) ?? {
      clientName: 'Pending client mapping',
      vertical: deriveVerticalFromName(r.campaign),
    };
    const totalCost =
      r.payout + (r.emailCost ?? 0) + (r.smsCost ?? 0) + (r.validationCost ?? 0);
    return {
      campaignId: r.campaign,
      campaignName: r.campaign,
      clientName: meta.clientName,
      vertical: meta.vertical,
      leads: r.leads,
      validLeads: r.valid,
      cost: Math.round(totalCost * 100) / 100,
      revenue: Math.round(r.revenue * 100) / 100,
      cpl: r.leads > 0 ? Math.round((totalCost / r.leads) * 100) / 100 : 0,
      profit: Math.round(r.profit * 100) / 100,
      margin: r.revenue > 0 ? Math.round(((r.revenue - totalCost) / r.revenue) * 1000) / 10 : 0,
    };
  });
}

export async function getClientPnl(requester: AuthPayload): Promise<ClientPnlRow[]> {
  // Real query: per-client per-month revenue (sum of paid invoices) + cost
  // (sum of lead-delivery costs) over the last 6 months.
  // Both queries are scoped via INNER JOIN through clients to enforce the
  // requester's businessId — without this, P&L for one tenant would leak
  // rows from every other tenant once we move past Phase 1.
  const businessId = requester.businessId;
  if (!businessId) return [];

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  sixMonthsAgo.setDate(1);
  const sixMonthsAgoIso = sixMonthsAgo.toISOString().split('T')[0];

  const [revenueRows, costRows] = await Promise.all([
    db
      .select({
        clientId: invoices.clientId,
        month: sql<string>`to_char(${invoices.createdAt}, 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${invoices.total}), 0)`,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(and(
        eq(clients.businessId, businessId),
        eq(invoices.status, 'paid'),
        gte(invoices.createdAt, sixMonthsAgo),
      ))
      .groupBy(invoices.clientId, sql`to_char(${invoices.createdAt}, 'YYYY-MM')`),
    db
      .select({
        clientId: leadDeliveries.clientId,
        month: sql<string>`to_char(${leadDeliveries.deliveryDate}, 'YYYY-MM')`,
        cost: sql<string>`coalesce(sum(${leadDeliveries.cost}), 0)`,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .innerJoin(clients, eq(clients.id, leadDeliveries.clientId))
      .where(and(
        eq(clients.businessId, businessId),
        gte(leadDeliveries.deliveryDate, sixMonthsAgoIso),
      ))
      .groupBy(leadDeliveries.clientId, sql`to_char(${leadDeliveries.deliveryDate}, 'YYYY-MM')`),
  ]);

  // No real data → return empty. UI shows an empty state. We deliberately
  // do NOT fabricate numbers here.
  if (revenueRows.length === 0 && costRows.length === 0) return [];

  const clientNames = new Map<string, string>();
  for (const c of await db.select({ id: clients.id, name: clients.companyName }).from(clients)) {
    clientNames.set(c.id, c.name);
  }

  // Merge revenue + cost by clientId+month.
  const merged = new Map<string, ClientPnlRow>();
  for (const r of revenueRows) {
    const key = `${r.clientId}|${r.month}`;
    merged.set(key, {
      clientId: r.clientId,
      clientName: clientNames.get(r.clientId) ?? 'Unknown',
      month: r.month,
      revenue: Number(r.revenue),
      cost: 0,
      profit: Number(r.revenue),
      margin: 100,
      leadsDelivered: 0,
    });
  }
  for (const c of costRows) {
    const key = `${c.clientId}|${c.month}`;
    const existing = merged.get(key);
    const cost = Number(c.cost);
    if (existing) {
      existing.cost = cost;
      existing.profit = existing.revenue - cost;
      existing.margin = existing.revenue > 0
        ? Math.round(((existing.revenue - cost) / existing.revenue) * 1000) / 10
        : 0;
      existing.leadsDelivered = c.leads;
    } else {
      merged.set(key, {
        clientId: c.clientId,
        clientName: clientNames.get(c.clientId) ?? 'Unknown',
        month: c.month,
        revenue: 0,
        cost,
        profit: -cost,
        margin: 0,
        leadsDelivered: c.leads,
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export async function getSupplierPerformance(
  _requester: AuthPayload,
  window: DeliveryWindow = 'this_month',
): Promise<SupplierReportRow[]> {
  const spendRows = await leadbyte.getSupplierSpend(window);

  // Empty when LeadByte returns nothing — UI handles the empty state.
  // Removed the canned-numbers fallback; users should never see fabricated
  // supplier spend.
  if (spendRows.length === 0) return [];

  // Aggregate by supplier (collapse across campaigns)
  const bySupplier = new Map<string, SupplierReportRow>();
  for (const r of spendRows) {
    const existing = bySupplier.get(r.supplierId);
    if (existing) {
      existing.totalSpend += r.spend;
      existing.totalLeads += r.leads;
      existing.campaigns += 1;
      existing.cpl = existing.totalLeads > 0
        ? Math.round((existing.totalSpend / existing.totalLeads) * 100) / 100
        : 0;
    } else {
      bySupplier.set(r.supplierId, {
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        platform: r.platform,
        totalSpend: r.spend,
        totalLeads: r.leads,
        cpl: r.cpl,
        campaigns: 1,
      });
    }
  }

  return [...bySupplier.values()].sort((a, b) => b.totalSpend - a.totalSpend);
}

export async function getFinancialOverview(_requester: AuthPayload): Promise<FinancialOverviewRow[]> {
  // Real query: last 12 months of revenue (paid invoices), expenses (ad
  // spend from Catchr), and invoice status counts per month. This drives
  // the dashboard's revenue-vs-expenses chart.
  //
  // Buckets by `invoices.dueDate` rather than `createdAt`: every paid
  // invoice's created_at equals its Xero sync time (~May 2026), which
  // collapsed the whole 12-month chart into a single bar. `due_date`
  // carries the actual invoice period from Xero, so historical revenue
  // back to mid-2025 renders correctly.
  //
  // Expenses now come from `ad_spend.spend` (live Catchr feed) rather
  // than `lead_deliveries.cost`, which is never populated (every row
  // is £0). The same bug zeroed-out the Expenses series on the chart.
  //
  // Falls back to demo numbers only if BOTH tables are empty.
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  const twelveMonthsAgoIso = twelveMonthsAgo.toISOString().split('T')[0];

  const [revenueRows, expenseRows, invoiceCountRows] = await Promise.all([
    db
      .select({
        month: sql<string>`to_char(${invoices.dueDate}, 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${invoices.total}), 0)`,
        vat: sql<string>`coalesce(sum(${invoices.vatAmount}), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.status, 'paid'), gte(invoices.dueDate, twelveMonthsAgo)))
      .groupBy(sql`to_char(${invoices.dueDate}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${adSpend.date}, 'YYYY-MM')`,
        expenses: sql<string>`coalesce(sum(${adSpend.spend}), 0)`,
      })
      .from(adSpend)
      .where(gte(adSpend.date, twelveMonthsAgoIso))
      .groupBy(sql`to_char(${adSpend.date}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${invoices.dueDate}, 'YYYY-MM')`,
        status: invoices.status,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(gte(invoices.dueDate, twelveMonthsAgo))
      .groupBy(sql`to_char(${invoices.dueDate}, 'YYYY-MM')`, invoices.status),
  ]);

  // No real data → return empty. UI charts fall back to a flat-zero
  // series rather than fabricating numbers.
  if (revenueRows.length === 0 && expenseRows.length === 0) return [];

  // Build the last 12 months as zero-baseline rows so charts always render
  // a continuous timeline even if some months had no activity.
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const currentMonthKey = months[months.length - 1];

  const revenueByMonth = new Map(revenueRows.map((r) => [r.month, { revenue: Number(r.revenue), vat: Number(r.vat) }]));
  const expensesByMonth = new Map(expenseRows.map((r) => [r.month, Number(r.expenses)]));
  // Months that have AT LEAST ONE ad_spend row. Pre-Catchr months land here
  // as `null` (not 0) so the chart can render a gap rather than implying
  // Sam ran his business cost-free for 9 months.
  const monthsWithCostData = new Set(expensesByMonth.keys());
  const paidByMonth = new Map<string, number>();
  const overdueByMonth = new Map<string, number>();
  // Pending = anything that's not 'paid' and not 'overdue' (drafts, sent,
  // due-but-not-late). Sum into a single bucket per month so the dashboard
  // Invoice Status chart's third bar shows real numbers instead of the
  // hardcoded zero it used to.
  const pendingByMonth = new Map<string, number>();
  for (const c of invoiceCountRows) {
    if (c.status === 'paid') {
      paidByMonth.set(c.month, c.count);
    } else if (c.status === 'overdue') {
      overdueByMonth.set(c.month, c.count);
    } else {
      pendingByMonth.set(c.month, (pendingByMonth.get(c.month) ?? 0) + c.count);
    }
  }

  return months.map((m): FinancialOverviewRow => {
    const r = revenueByMonth.get(m) ?? { revenue: 0, vat: 0 };
    const expenses = monthsWithCostData.has(m) ? (expensesByMonth.get(m) ?? 0) : null;
    const [year, mm] = m.split('-');
    const monthLabel = new Date(Number(year), Number(mm) - 1, 1).toLocaleDateString('en-GB', {
      month: 'short',
      year: 'numeric',
    });
    return {
      month: monthLabel,
      revenue: Math.round(r.revenue * 100) / 100,
      expenses: expenses === null ? null : Math.round(expenses * 100) / 100,
      profit: expenses === null
        ? Math.round(r.revenue * 100) / 100
        : Math.round((r.revenue - expenses) * 100) / 100,
      invoicesPaid: paidByMonth.get(m) ?? 0,
      invoicesOverdue: overdueByMonth.get(m) ?? 0,
      invoicesPending: pendingByMonth.get(m) ?? 0,
      vatCollected: Math.round(r.vat * 100) / 100,
      isPartial: m === currentMonthKey,
    };
  });
}

// ─── P&L three-bucket summary (Sam's 2026-04-28 brief) ─────────────────────
//
// Revenue (from paid invoices) vs (fixed costs + one-off costs + ad spend)
// over the last `days` days. Uses the bank-feed categorisation tables
// (bank_transactions joined to cost_categories) for cost buckets.

import { bankTransactions, costCategories } from '../db/schema/bank-feed.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { lte } from 'drizzle-orm';

export interface PnlSummary {
  fromDate: string;
  toDate: string;
  currency: string;
  revenue: string;
  fixedCosts: string;
  oneOffCosts: string;
  /** Bank-fed advertising rows (Sam Loom #13) — Facebook/Google card bills
   *  the user categorises as the 'advertising' bucket. Separate from
   *  Catchr's `adSpend` so the two views (bank-side vs API-side) stay
   *  independent. */
  advertisingCosts: string;
  adSpend: string;
  totalCosts: string;
  netProfit: string;
  margin: string; // 0..1 fraction (e.g. "0.42" = 42%)
  uncategorisedCount: number;
  /**
   * Catchr ad-spend rows in window whose Catchr-campaign-id hasn't been
   * mapped to a Stato client yet. They're excluded from `adSpend` because
   * we can't attribute them to a tenant — surfaced so the UI can prompt
   * Sam to fill the mapping.
   */
  unattributedSpendRows: number;
}

/**
 * Slice 4 Day 1 — the unified leadreports.io report. Sam Loom #72-85.
 *
 * One row per (campaign × supplier). LeadByte gives us:
 *   - per-campaign revenue + total leads via /reports/campaign
 *   - per-(campaign × supplier) spend + leads via /reports/supplier
 *
 * To get per-supplier revenue, we allocate campaign revenue across suppliers
 * by their lead share: `supplierRevenue = campaignRevenue × supplierLeads /
 * campaignLeads`. This matches what leadreports.io shows — a per-row
 * revenue figure that, when you sum across suppliers, equals the campaign
 * total.
 *
 * Filters keep the query simple: `supplier` (platform substring or name) and
 * `campaign` (substring against campaign name). Date range comes from
 * DeliveryWindow.
 */
export interface UnifiedReportFilters {
  window?: DeliveryWindow;
  supplier?: string;     // platform or supplier-name substring
  campaign?: string;     // campaign-name substring
}

export async function getUnifiedReport(
  _requester: AuthPayload,
  filters: UnifiedReportFilters = {},
): Promise<UnifiedReport> {
  const window: DeliveryWindow = filters.window ?? 'this_month';

  // Fetch in parallel: LeadByte gives us the LB-side numbers; the DB query
  // resolves campaign meta (clientName + vertical) and Catchr NCP mapping.
  const [campaignRows, supplierRows, campaignMeta, sourcesRows] = await Promise.all([
    leadbyte.getCampaignReport(window),
    leadbyte.getSupplierSpend(window),
    loadCampaignMetaByName(),
    // Pull Catchr NCP URLs keyed by (campaignId-or-name, platform). Both keys
    // are stored on traffic_sources rows; we resolve them after the join.
    db
      .select({
        campaignId: trafficSources.campaignId,
        platform: trafficSources.platform,
        catchrUrl: trafficSources.catchrUrl,
      })
      .from(trafficSources)
      .where(eq(trafficSources.isActive, true)),
  ]);

  // Build revenue-per-lead by campaign name so we can allocate.
  const revenuePerLeadByCampaign = new Map<string, number>();
  for (const c of campaignRows) {
    if (c.leads > 0) revenuePerLeadByCampaign.set(c.campaign, c.revenue / c.leads);
    else revenuePerLeadByCampaign.set(c.campaign, 0);
  }

  // Catchr NCP lookup keyed by platform (lowercased) — Sato-side traffic
  // sources are scoped per-campaign; we key them on platform alone since
  // the supplier report doesn't carry our Sato campaign UUID. Good enough
  // for Phase 1 where Sam has one Catchr account per platform anyway.
  const catchrByPlatform = new Map<string, string>();
  for (const s of sourcesRows) {
    if (s.platform && s.catchrUrl) {
      const key = s.platform.toLowerCase();
      // First-write wins so we don't keep overwriting if the same platform
      // is mapped on multiple campaigns. Per-campaign override is a Day 2+
      // refinement.
      if (!catchrByPlatform.has(key)) catchrByPlatform.set(key, s.catchrUrl);
    }
  }

  // Apply filters BEFORE the row map so we don't allocate work we'll throw away.
  const supplierFilter = filters.supplier?.toLowerCase() ?? '';
  const campaignFilter = filters.campaign?.toLowerCase() ?? '';
  const filteredSupplierRows = supplierRows.filter((r) => {
    if (campaignFilter && !r.campaignName.toLowerCase().includes(campaignFilter)) return false;
    if (supplierFilter) {
      const matchesPlatform = r.platform.toLowerCase().includes(supplierFilter);
      const matchesName = r.supplierName.toLowerCase().includes(supplierFilter);
      if (!matchesPlatform && !matchesName) return false;
    }
    return true;
  });

  const rows: UnifiedReportRow[] = filteredSupplierRows.map((r) => {
    const meta = campaignMeta.get(r.campaignName) ?? {
      clientName: 'Pending client mapping',
      vertical: deriveVerticalFromName(r.campaignName),
    };
    const revenuePerLead = revenuePerLeadByCampaign.get(r.campaignName) ?? 0;
    const revenue = Math.round(revenuePerLead * r.leads * 100) / 100;
    const profit = Math.round((revenue - r.spend) * 100) / 100;
    const margin = revenue > 0 ? Math.round(((revenue - r.spend) / revenue) * 1000) / 10 : 0;
    const catchrUrl = catchrByPlatform.get(r.platform.toLowerCase()) ?? null;

    return {
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      clientName: meta.clientName,
      vertical: meta.vertical,
      supplier: r.supplierName,
      supplierPlatform: r.platform,
      catchrUrl,
      leads: r.leads,
      spend: Math.round(r.spend * 100) / 100,
      revenue,
      profit,
      cpl: r.leads > 0 ? Math.round((r.spend / r.leads) * 100) / 100 : 0,
      margin,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  // Totals across the filtered rows. Margin is recomputed (not averaged)
  // from the totalled revenue + spend so it's mathematically consistent.
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totals: UnifiedReportTotals = {
    leads: rows.reduce((s, r) => s + r.leads, 0),
    spend: Math.round(totalSpend * 100) / 100,
    revenue: Math.round(totalRevenue * 100) / 100,
    profit: Math.round((totalRevenue - totalSpend) * 100) / 100,
    margin: totalRevenue > 0
      ? Math.round(((totalRevenue - totalSpend) / totalRevenue) * 1000) / 10
      : 0,
  };

  return { rows, totals };
}

export async function getPnlSummary(
  requester: AuthPayload,
  days = 30,
): Promise<PnlSummary> {
  const businessId = requester.businessId;
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - days);
  const fromIso = fromDate.toISOString().slice(0, 10);
  const toIso = today.toISOString().slice(0, 10);

  // Revenue = sum(invoices.total) where status='paid' AND createdAt in window
  // (invoices table is single-tenant in Phase 1 so no businessId scope yet)
  const [revenueRow] = await db
    .select({ total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)::text` })
    .from(invoices)
    .where(
      and(
        eq(invoices.status, 'paid'),
        gte(invoices.createdAt, fromDate),
        lte(invoices.createdAt, today),
      ),
    );

  // Costs by bucket from bank_transactions (amount is signed; SPEND is negative).
  const txWhere = and(
    gte(bankTransactions.date, fromIso),
    lte(bankTransactions.date, toIso),
    businessId ? eq(bankTransactions.businessId, businessId) : sql`true`,
  );
  const costByBucket = await db
    .select({
      bucket: costCategories.bucket,
      total: sql<string>`coalesce(sum(abs(${bankTransactions.amount}::numeric)), 0)::text`,
    })
    .from(bankTransactions)
    .leftJoin(costCategories, eq(costCategories.id, bankTransactions.categoryId))
    .where(txWhere)
    .groupBy(costCategories.bucket);

  let fixed = 0;
  let oneOff = 0;
  let advertising = 0;
  let uncategorisedCount = 0;
  for (const row of costByBucket) {
    const amount = parseFloat(row.total) || 0;
    if (row.bucket === 'fixed') fixed += amount;
    else if (row.bucket === 'one_off') oneOff += amount;
    else if (row.bucket === 'advertising') advertising += amount;
    else uncategorisedCount = Math.round(amount); // null bucket = uncategorised; we'll re-count below
  }

  // Re-count uncategorised as a row count (more useful UI signal than a sum)
  const [uncatRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(and(txWhere, isNull(bankTransactions.categoryId)));
  uncategorisedCount = uncatRow?.count ?? 0;

  // Ad spend from Catchr. The ad_spend table has no business_id column yet,
  // so we tenant-scope via a join through clients (ad_spend.client_id →
  // clients.business_id). Side effect: rows where Sam hasn't yet mapped a
  // Catchr campaign to a Stato client (clientId IS NULL) are excluded — that
  // was the source of the cross-tenant Poland-spend leak Sam reported (#74,
  // #109). Until those rows get a client mapping, they don't attribute to
  // anyone's P&L. unattributedSpendRows is surfaced so the UI can prompt
  // for the mapping.
  const adSpendRows = businessId
    ? await db
        .select({ total: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text` })
        .from(adSpend)
        .innerJoin(clients, eq(clients.id, adSpend.clientId))
        .where(
          and(
            eq(clients.businessId, businessId),
            gte(adSpend.date, fromIso),
            lte(adSpend.date, toIso),
          ),
        )
    : [];
  const adSpendRow = adSpendRows[0];

  const [unattributedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adSpend)
    .where(
      and(
        isNull(adSpend.clientId),
        gte(adSpend.date, fromIso),
        lte(adSpend.date, toIso),
      ),
    );
  const unattributedSpendRows = unattributedRow?.count ?? 0;

  const revenue = parseFloat(revenueRow?.total ?? '0');
  const adSpendTotal = parseFloat(adSpendRow?.total ?? '0');
  const totalCosts = fixed + oneOff + advertising + adSpendTotal;
  const netProfit = revenue - totalCosts;
  const margin = revenue > 0 ? netProfit / revenue : 0;

  return {
    fromDate: fromIso,
    toDate: toIso,
    currency: 'GBP',
    revenue: revenue.toFixed(2),
    fixedCosts: fixed.toFixed(2),
    oneOffCosts: oneOff.toFixed(2),
    advertisingCosts: advertising.toFixed(2),
    adSpend: adSpendTotal.toFixed(2),
    totalCosts: totalCosts.toFixed(2),
    netProfit: netProfit.toFixed(2),
    margin: margin.toFixed(4),
    uncategorisedCount,
    unattributedSpendRows,
  };
}
