import { and, eq, sql, isNull, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { clients } from '../db/schema/clients.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { adSpend } from '../db/schema/ad-spend.js';
import type { AuthPayload } from '../types/index.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';
import { cached } from '../utils/cache.js';

// Cache TTL for LeadByte report calls used by /reports/unified. Mirrors the
// TTL used by campaign.service so the key/TTL pairing is consistent across
// consumers of `lb:report:{w}:v5` and `lb:supplier-spend:{w}:v1`.
const UNIFIED_REPORT_TTL_SECONDS = 900;

// LeadByte DeliveryWindow → ISO date range. Mirrors leadbyte-client.windowToRange
// but lives here so report.service can run its own Catchr ad_spend query.
function deliveryWindowToRange(win: DeliveryWindow): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().split('T')[0];
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  switch (win) {
    case 'today':       return { from: iso(now), to: iso(now) };
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { from: iso(y), to: iso(y) };
    }
    case 'this_week': {
      const start = startOfDay(now); start.setDate(start.getDate() - start.getDay());
      return { from: iso(start), to: iso(now) };
    }
    case 'last_week': {
      const end = startOfDay(now); end.setDate(end.getDate() - end.getDay() - 1);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      return { from: iso(start), to: iso(end) };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: iso(start), to: iso(now) };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end   = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: iso(start), to: iso(end) };
    }
    case 'ytd':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
  }
}

// Map a LeadByte supplier name to the canonical Catchr `ad_spend.platform`
// identifier. LeadByte's supplier names are freeform / mixed-case (e.g.
// "Facebook Ads", "facebook", "Google Ads"); Catchr stores platforms as
// hyphenated lowercase, the exact strings in CatchrPlatform.
//
// Canonical values must match the source-of-truth strings in
// src/integrations/catchr/catchr-types.ts (`CatchrPlatform`):
//   facebook-ads · google-ads · bing-ads · tik-tok · taboola
//
// Returns null when the supplier doesn't have an ad-platform counterpart
// (e.g. "Direct", "Community Manager", "Trustpilot") — those should keep
// totalSpend=0 since no ad-network paid for them. Returns null also for
// platforms Catchr supports but we haven't wired up (Outbrain, LinkedIn,
// Snapchat, etc.) so we don't lookup a key that never returns rows.
function supplierNameToCatchrPlatform(supplierName: string): string | null {
  const n = supplierName.toLowerCase().trim();
  if (!n) return null;
  if (n.includes('facebook') || n === 'meta' || n.includes('meta ads')) return 'facebook-ads';
  if (n.includes('google')) return 'google-ads';
  if (n.includes('tiktok') || n.includes('tik tok') || n.includes('tik-tok')) return 'tik-tok';
  if (n.includes('taboola')) return 'taboola';
  if (n.includes('microsoft') || n === 'bing' || n.includes('bing ads')) return 'bing-ads';
  return null;
}

export interface CampaignReportRow {
  campaignId: string;
  campaignName: string;
  clientName: string;
  /**
   * OCT-42 (2026-05-21): full list of buyers linked to this campaign via
   * `client_campaigns`. Frontend renders "Multiple (N)" with tooltip when
   * length > 1. Empty array for unmapped campaigns; `clientName` then
   * reads "Pending client mapping".
   */
  clientNames: string[];
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
  /** OCT-42: all buyers linked to the campaign. See CampaignReportRow.clientNames. */
  clientNames: string[];
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

/**
 * Sam (2026-05-15 meeting #10): "Facebook spend → Facebook profit / margin"
 * row — the cross-campaign, per-platform roll-up LeadReports.io shows.
 *
 * One row per Catchr platform (or LeadByte supplier-platform string when no
 * Catchr mapping exists). Same money as the per-(campaign × supplier) rows,
 * just summed across campaigns so Σ(byPlatform.revenue) === totals.revenue
 * and Σ(byPlatform.spend) === totals.spend. We do NOT re-derive revenue from
 * LeadByte — the per-row proportional allocation already gave us the right
 * numbers; this is a pure SUM over the existing rows.
 *
 * `catchrUrl` is enriched the same way as the per-supplier rows so users can
 * jump straight to the Catchr NCP from the aggregated row.
 */
export interface UnifiedReportPlatformRow {
  /** Display name — uses the raw LeadByte platform string ("Facebook Ads",
   * "Direct", etc.) since that's what Sam reads on LeadReports.io. */
  platform: string;
  catchrUrl: string | null;
  leads: number;
  spend: number;
  revenue: number;
  profit: number;
  cpl: number;
  margin: number;
}

export interface UnifiedReport {
  rows: UnifiedReportRow[];
  totals: UnifiedReportTotals;
  /**
   * Sam (2026-05-15 meeting #10) — per-platform roll-up. Additive field; older
   * frontend builds that don't read it stay working unchanged.
   */
  byPlatform: UnifiedReportPlatformRow[];
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

/**
 * Invoice statuses that count as recognised revenue.
 *
 * Xero defaults to accrual accounting: an invoice is recognised the moment
 * it's issued (AUTHORISED) — not when cash clears the bank (PAID). A filter
 * that only matched `status='paid'` zeroed out every legitimately-issued
 * invoice still awaiting payment, which made `financial-overview` and
 * `dashboard/stats` show `revenue: 0` even when the invoices table had
 * real authorised data.
 *
 * Both 'paid' and 'authorised' are recognised here; 'sent', 'draft', and
 * 'overdue' (the live-derived display status) stay out — drafts aren't
 * legally issued and overdue is just an authorised invoice past due date,
 * already counted via 'authorised'.
 *
 * Exported so `dashboard.service.ts` shares the exact same definition.
 */
export const RECOGNISED_INVOICE_STATUSES = ['paid', 'authorised'] as const;

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
// Vertical derivation now lives in src/utils/vertical.ts so the same
// keyword map drives both the reports' campaign-meta lookup and the
// dashboard's Campaign Sources pie chart (which was rendering 100%
// "Other" because campaigns.vertical is uniformly null in prod).
import { deriveVerticalFromName } from '../utils/vertical.js';

async function loadCampaignMetaByName(): Promise<Map<string, { clientName: string; clientNames: string[]; vertical: string }>> {
  // Single query that produces one row per (campaign, buyer) pair via the
  // `client_campaigns` junction. Multi-buyer campaigns get N rows that we
  // then collapse into a single map entry with `clientNames[]`.
  //
  // OCT-42 (2026-05-21): replaces the prior leftJoin on the legacy
  // `campaigns.client_id` singular column — which silently zeroed out the
  // buyer name for every campaign linked via client_campaigns instead.
  const rows = await db
    .select({
      name: campaignsTable.name,
      vertical: campaignsTable.vertical,
      buyerName: clients.companyName,
    })
    .from(campaignsTable)
    .leftJoin(clientCampaigns, eq(clientCampaigns.campaignId, campaignsTable.id))
    .leftJoin(clients, eq(clients.id, clientCampaigns.clientId));

  const map = new Map<string, { clientName: string; clientNames: string[]; vertical: string }>();
  for (const r of rows) {
    if (!r.name) continue;
    const existing = map.get(r.name);
    if (!existing) {
      const initialNames = r.buyerName ? [r.buyerName] : [];
      map.set(r.name, {
        clientName: r.buyerName ?? 'Pending client mapping',
        clientNames: initialNames,
        // Vertical can be derived from the campaign name itself
        // ("Hearing Aids (PL)" → Hearing Aids). Falls back to derived
        // even when the synced row exists but has no vertical column.
        vertical: r.vertical && r.vertical !== 'Unmapped'
          ? r.vertical
          : deriveVerticalFromName(r.name),
      });
    } else if (r.buyerName && !existing.clientNames.includes(r.buyerName)) {
      existing.clientNames.push(r.buyerName);
    }
  }
  // Sort names alpha for stable rendering and resolve the display name.
  for (const meta of map.values()) {
    meta.clientNames.sort((a, b) => a.localeCompare(b));
    if (meta.clientNames.length === 0) {
      meta.clientName = 'Pending client mapping';
    } else {
      meta.clientName = meta.clientNames[0];
    }
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
      clientNames: [] as string[],
      vertical: deriveVerticalFromName(r.campaign),
    };
    const totalCost =
      r.payout + (r.emailCost ?? 0) + (r.smsCost ?? 0) + (r.validationCost ?? 0);
    return {
      campaignId: r.campaign,
      campaignName: r.campaign,
      clientName: meta.clientName,
      clientNames: meta.clientNames,
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

  // Step 1 — aggregate LeadByte rows by supplier (collapse across campaigns).
  // The `spend` LeadByte returns is `payout` — what we owe the supplier
  // directly — which is £0 for ad-platform suppliers (Facebook, Google
  // Ads, Taboola, etc.) because the spend lives on Catchr. We'll merge
  // Catchr's number in next.
  const bySupplier = new Map<string, SupplierReportRow>();
  // Also collapse mixed-case duplicates ("facebook" + "Facebook Ads") so
  // the Catchr spend isn't double-shown — track which Catchr platform
  // each supplier maps to and dedupe on that.
  const catchrPlatformKey = new Map<string, string>(); // supplierId → catchr platform
  for (const r of spendRows) {
    const existing = bySupplier.get(r.supplierId);
    if (existing) {
      existing.totalSpend += r.spend;
      existing.totalLeads += r.leads;
      existing.campaigns += 1;
    } else {
      bySupplier.set(r.supplierId, {
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        platform: r.platform,
        totalSpend: r.spend,
        totalLeads: r.leads,
        cpl: 0, // computed at the end after Catchr merge
        campaigns: 1,
      });
    }
    const catchrPlat = supplierNameToCatchrPlatform(r.supplierName);
    if (catchrPlat) catchrPlatformKey.set(r.supplierId, catchrPlat);
  }

  // Step 2 — pull Catchr ad_spend per platform for the same window and
  // merge into the supplier rows. This is what fills in the £0 spend on
  // every ad-platform supplier row.
  const platforms = [...new Set(catchrPlatformKey.values())];
  if (platforms.length > 0) {
    const { from, to } = deliveryWindowToRange(window);
    const catchrRows = await db
      .select({
        platform: adSpend.platform,
        spend: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text`,
      })
      .from(adSpend)
      .where(and(
        inArray(adSpend.platform, platforms),
        gte(adSpend.date, from),
        lte(adSpend.date, to),
      ))
      .groupBy(adSpend.platform);

    const catchrSpendByPlatform = new Map(
      catchrRows.map((r) => [r.platform, Number(r.spend)]),
    );

    // For each supplier row that has a Catchr-platform match, OVERRIDE
    // totalSpend with Catchr's number (LeadByte's £0 is wrong). Distribute
    // the platform's total across all suppliers mapped to that platform
    // (e.g. "facebook" + "Facebook Ads") proportionally to their lead share
    // so the platform total isn't double-counted in the table sum.
    const supplierIdsByCatchr = new Map<string, string[]>();
    for (const [supId, plat] of catchrPlatformKey.entries()) {
      if (!supplierIdsByCatchr.has(plat)) supplierIdsByCatchr.set(plat, []);
      supplierIdsByCatchr.get(plat)!.push(supId);
    }

    for (const [plat, supIds] of supplierIdsByCatchr.entries()) {
      const platSpend = catchrSpendByPlatform.get(plat) ?? 0;
      if (platSpend === 0) continue;
      const totalLeadsAcrossSupIds = supIds.reduce(
        (acc, id) => acc + (bySupplier.get(id)?.totalLeads ?? 0),
        0,
      );
      for (const supId of supIds) {
        const row = bySupplier.get(supId);
        if (!row) continue;
        const share = totalLeadsAcrossSupIds > 0
          ? row.totalLeads / totalLeadsAcrossSupIds
          : 1 / supIds.length;
        row.totalSpend = Math.round(platSpend * share * 100) / 100;
      }
    }
  }

  // Step 3 — recompute CPL across the merged rows now that totalSpend is
  // populated from Catchr.
  for (const row of bySupplier.values()) {
    row.cpl = row.totalLeads > 0
      ? Math.round((row.totalSpend / row.totalLeads) * 100) / 100
      : 0;
  }

  return [...bySupplier.values()].sort((a, b) => b.totalSpend - a.totalSpend);
}

/**
 * Number of monthly buckets to return for each dashboard window. Short
 * windows still show a small multi-month context (3 months) because a
 * single-bar chart isn't useful. last_year keeps the original 12-month
 * series so the no-filter response is byte-identical to the legacy one.
 */
function monthsForFinancialOverviewWindow(window: import('../utils/dashboard-window.js').DashboardWindow | undefined): number {
  switch (window) {
    case 'this_week':
    case 'this_month':
    case 'last_month':
    case 'last_90d':
      return 3;
    case 'last_6m':
      return 6;
    case 'last_year':
    default:
      return 12;
  }
}

export async function getFinancialOverview(
  _requester: AuthPayload,
  opts: { window?: import('../utils/dashboard-window.js').DashboardWindow } = {},
): Promise<FinancialOverviewRow[]> {
  // Real query: last 12 months of revenue (paid + authorised invoices),
  // expenses (ad spend from Catchr), and invoice status counts per month.
  // This drives the dashboard's revenue-vs-expenses chart.
  //
  // Buckets by `invoices.dueDate` rather than `createdAt`: every paid
  // invoice's created_at equals its Xero sync time (~May 2026), which
  // collapsed the whole 12-month chart into a single bar. `due_date`
  // carries the actual invoice period from Xero, so historical revenue
  // back to mid-2025 renders correctly.
  //
  // Revenue recognition uses RECOGNISED_INVOICE_STATUSES (paid + authorised)
  // — see the constant's docblock. The previous `status='paid'` filter
  // produced cash-basis numbers that read as zero on every recently-issued
  // invoice. Note: as of 2026-05-22, live Xero sync is rate-limited (429)
  // so the invoices table mostly contains locally-created drafts; this
  // change fixes the aggregation so once sync catches up, AUTHORISED rows
  // will roll into the revenue series correctly.
  //
  // Expenses now come from `ad_spend.spend` (live Catchr feed) rather
  // than `lead_deliveries.cost`, which is never populated (every row
  // is £0). The same bug zeroed-out the Expenses series on the chart.
  //
  // Falls back to demo numbers only if BOTH tables are empty.
  //
  // monthsCount is driven by the dashboard window filter when supplied —
  // last_year (default / no filter) keeps the legacy 12-month series.
  const monthsCount = monthsForFinancialOverviewWindow(opts.window);
  const windowStart = new Date();
  windowStart.setMonth(windowStart.getMonth() - (monthsCount - 1));
  windowStart.setDate(1);
  const windowStartIso = windowStart.toISOString().split('T')[0];

  const [revenueRows, expenseRows, invoiceCountRows] = await Promise.all([
    db
      .select({
        month: sql<string>`to_char(${invoices.dueDate}, 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${invoices.total}), 0)`,
        vat: sql<string>`coalesce(sum(${invoices.vatAmount}), 0)`,
      })
      .from(invoices)
      .where(and(inArray(invoices.status, RECOGNISED_INVOICE_STATUSES as unknown as string[]), gte(invoices.dueDate, windowStart)))
      .groupBy(sql`to_char(${invoices.dueDate}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${adSpend.date}, 'YYYY-MM')`,
        expenses: sql<string>`coalesce(sum(${adSpend.spend}), 0)`,
      })
      .from(adSpend)
      .where(gte(adSpend.date, windowStartIso))
      .groupBy(sql`to_char(${adSpend.date}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${invoices.dueDate}, 'YYYY-MM')`,
        status: invoices.status,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(gte(invoices.dueDate, windowStart))
      .groupBy(sql`to_char(${invoices.dueDate}, 'YYYY-MM')`, invoices.status),
  ]);

  // No real data → return empty. UI charts fall back to a flat-zero
  // series rather than fabricating numbers.
  if (revenueRows.length === 0 && expenseRows.length === 0) return [];

  // Build the trailing monthsCount months as zero-baseline rows so charts
  // always render a continuous timeline even if some months had no activity.
  const months: string[] = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
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
  //
  // BUG FIX (2026-05-22): Both LeadByte calls now go through `cached()` with
  // the SAME cache keys as campaign.service / cache-prewarm — previously the
  // unified report called LeadByte directly, which meant:
  //   1. We bypassed the warm cache the campaigns page just populated
  //   2. Every unified request hit LeadByte twice in parallel, racing the
  //      rate-limiter — when one of the two returned empty, the report
  //      silently surfaced 0 rows OR 55 rows with revenue=0 (campaign-map
  //      empty → no revenue-per-lead → every row got £0). The negative-cache
  //      in cached() also absorbs transient upstream blips for 30s instead
  //      of every caller re-hammering the rate-limited endpoint.
  const [campaignRows, supplierRows, campaignMeta, sourcesRows] = await Promise.all([
    cached(`lb:report:${window}:v5`, UNIFIED_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport(window)),
    cached(`lb:supplier-spend:${window}:v1`, UNIFIED_REPORT_TTL_SECONDS, () => leadbyte.getSupplierSpend(window)),
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

  // BUG FIX (2026-05-22): LeadByte's `/reports/campaign` and `/reports/supplier`
  // return inconsistent lead counts for the same campaign × window. Example
  // discovered live for Hearing Aids (IE), 2026-05 month-to-date:
  //   /reports/campaign:  leads=840  revenue=£15,189.20  (matches LeadReports.io)
  //   /reports/supplier:  Σ supplier.leads = 1,382       (counts cascade/route
  //                                                       presentations, not
  //                                                       unique deliveries)
  // The previous algorithm did `revPerLead = campaign.revenue / campaign.leads`
  // then `r.revenue = revPerLead × r.leads`, which inflated every multi-supplier
  // campaign's revenue by (Σ supplier.leads − campaign.leads). For Hearing
  // Aids (IE) that turned £15,189 into £24,989 (+65%).
  //
  // Correct allocation: distribute campaign.revenue across its supplier rows
  // PROPORTIONALLY to each supplier's share of the supplier-spend leads. This
  // guarantees Σ(supplier.revenue) per campaign === campaign.revenue (LeadByte
  // truth), without depending on the two endpoints' lead counts agreeing.
  const campaignRevenueByName = new Map<string, number>();
  const campaignLeadsByName = new Map<string, number>();
  for (const c of campaignRows) {
    campaignRevenueByName.set(c.campaign, c.revenue ?? 0);
    campaignLeadsByName.set(c.campaign, c.leads ?? 0);
  }
  const supplierLeadsSumByCampaign = new Map<string, number>();
  for (const r of supplierRows) {
    const prev = supplierLeadsSumByCampaign.get(r.campaignName) ?? 0;
    supplierLeadsSumByCampaign.set(r.campaignName, prev + (r.leads ?? 0));
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

  // Pull Catchr ad_spend per platform for the same window — used to override
  // the LeadByte `payout` field (which is £0 for ad-network suppliers like
  // Facebook / Google / Taboola). The supplier→Catchr-platform mapper is
  // the same one used by getSupplierPerformance.
  const catchrPlatformByRowIdx = new Map<number, string>();
  filteredSupplierRows.forEach((r, i) => {
    const plat = supplierNameToCatchrPlatform(r.supplierName);
    if (plat) catchrPlatformByRowIdx.set(i, plat);
  });
  const distinctCatchrPlatforms = [...new Set(catchrPlatformByRowIdx.values())];
  const catchrSpendByPlatform = new Map<string, number>();
  if (distinctCatchrPlatforms.length > 0) {
    const { from, to } = deliveryWindowToRange(window);
    const catchrRows = await db
      .select({
        platform: adSpend.platform,
        spend: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text`,
      })
      .from(adSpend)
      .where(and(
        inArray(adSpend.platform, distinctCatchrPlatforms),
        gte(adSpend.date, from),
        lte(adSpend.date, to),
      ))
      .groupBy(adSpend.platform);
    for (const r of catchrRows) catchrSpendByPlatform.set(r.platform, Number(r.spend));
  }

  // Build the row-lead totals per Catchr platform so we can distribute the
  // platform's Catchr spend across all rows that map to it proportionally
  // to each row's lead share. Without this, a single Facebook total of
  // £20k would get assigned in full to every Facebook row, double-counting.
  const totalLeadsByCatchrPlatform = new Map<string, number>();
  filteredSupplierRows.forEach((r, i) => {
    const plat = catchrPlatformByRowIdx.get(i);
    if (!plat) return;
    totalLeadsByCatchrPlatform.set(plat, (totalLeadsByCatchrPlatform.get(plat) ?? 0) + r.leads);
  });

  const rows: UnifiedReportRow[] = filteredSupplierRows.map((r, i) => {
    const meta = campaignMeta.get(r.campaignName) ?? {
      clientName: 'Pending client mapping',
      clientNames: [] as string[],
      vertical: deriveVerticalFromName(r.campaignName),
    };
    // See the campaignRevenueByName comment above for why this is proportional
    // allocation rather than revPerLead × r.leads.
    const campaignRevenue = campaignRevenueByName.get(r.campaignName) ?? 0;
    const campaignLeads = campaignLeadsByName.get(r.campaignName) ?? 0;
    const supplierLeadsSum = supplierLeadsSumByCampaign.get(r.campaignName) ?? 0;
    const revenue = supplierLeadsSum > 0
      ? Math.round((campaignRevenue * r.leads / supplierLeadsSum) * 100) / 100
      : 0;
    // BUG FIX (2026-05-22): LeadByte's /reports/supplier counts cascade-routing
    // EVENTS (a single lead presented to 2 suppliers in failover = 2 events),
    // not unique leads. /reports/campaign holds the unique lead count. Sum of
    // raw supplier.leads always >= campaign.leads. Without normalization, Stato
    // totals look inflated vs LeadByte's own dashboard + LeadReports.io.
    // Normalize via the same proportional allocation we use for revenue so
    // Σ(supplier.leads) per campaign === campaign.leads (LB unique-lead truth).
    const leads = supplierLeadsSum > 0 && campaignLeads > 0
      ? Math.round(campaignLeads * r.leads / supplierLeadsSum)
      : r.leads;

    // Override the LeadByte payout `r.spend` with the row's share of the
    // Catchr platform total — Catchr is the source of truth for ad-network
    // spend; LeadByte's payout column is consistently £0 for those rows.
    // Use r.leads (raw cascade-event count) for the allocation share — the
    // platform totals in totalLeadsByCatchrPlatform are also built from raw
    // r.leads, so the ratios are internally consistent. The normalized `leads`
    // variable above is for the displayed lead count only.
    const catchrPlat = catchrPlatformByRowIdx.get(i);
    let spend = r.spend;
    if (catchrPlat) {
      const platTotal = catchrSpendByPlatform.get(catchrPlat) ?? 0;
      const platLeads = totalLeadsByCatchrPlatform.get(catchrPlat) ?? 0;
      if (platTotal > 0 && platLeads > 0) {
        spend = (platTotal * r.leads) / platLeads;
      }
    }
    spend = Math.round(spend * 100) / 100;

    const profit = Math.round((revenue - spend) * 100) / 100;
    const margin = revenue > 0 ? Math.round(((revenue - spend) / revenue) * 1000) / 10 : 0;
    const catchrUrl = catchrByPlatform.get(r.platform.toLowerCase()) ?? null;

    return {
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      clientName: meta.clientName,
      clientNames: meta.clientNames,
      vertical: meta.vertical,
      supplier: r.supplierName,
      supplierPlatform: r.platform,
      catchrUrl,
      leads,
      spend,
      revenue,
      profit,
      // CPL = spend per actual lead (uses normalized `leads`, not the raw
      // cascade-event count). Matches how operators think about cost-per-lead.
      cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0,
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

  // Sam (2026-05-15 meeting #10) — "By source · profitability". Aggregate the
  // already-computed per-(campaign × supplier) rows by `supplierPlatform` so
  // operators can scan Facebook / Google / TikTok / Taboola / Direct totals
  // without flipping between campaign rows. This is a pure SUM over `rows`
  // (which already had revenue + spend allocated correctly above) — no second
  // LeadByte call, no re-derivation. Σ(byPlatform.revenue) === totals.revenue
  // and Σ(byPlatform.spend) === totals.spend by construction.
  //
  // We bucket on `supplierPlatform` (the LeadByte platform string) rather
  // than the canonical Catchr platform id because:
  //   1. Sam reads the same strings on LeadReports.io
  //   2. Suppliers without a Catchr counterpart (Direct, Community Manager,
  //      Trustpilot) still get their own row instead of collapsing to a
  //      single "Unknown" bucket
  // The Catchr NCP link is propagated from the first row in the bucket that
  // has one — same first-write-wins convention as catchrByPlatform above.
  const platformBuckets = new Map<string, {
    platform: string;
    catchrUrl: string | null;
    leads: number;
    spend: number;
    revenue: number;
  }>();
  for (const r of rows) {
    const key = r.supplierPlatform || 'Unknown';
    const existing = platformBuckets.get(key);
    if (existing) {
      existing.leads += r.leads;
      existing.spend += r.spend;
      existing.revenue += r.revenue;
      if (!existing.catchrUrl && r.catchrUrl) existing.catchrUrl = r.catchrUrl;
    } else {
      platformBuckets.set(key, {
        platform: key,
        catchrUrl: r.catchrUrl,
        leads: r.leads,
        spend: r.spend,
        revenue: r.revenue,
      });
    }
  }
  const byPlatform: UnifiedReportPlatformRow[] = Array.from(platformBuckets.values())
    .map((b) => {
      const spend = Math.round(b.spend * 100) / 100;
      const revenue = Math.round(b.revenue * 100) / 100;
      const profit = Math.round((revenue - spend) * 100) / 100;
      return {
        platform: b.platform,
        catchrUrl: b.catchrUrl,
        leads: b.leads,
        spend,
        revenue,
        profit,
        cpl: b.leads > 0 ? Math.round((spend / b.leads) * 100) / 100 : 0,
        margin: revenue > 0
          ? Math.round(((revenue - spend) / revenue) * 1000) / 10
          : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  return { rows, totals, byPlatform };
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

  // Tenant scope guard — without a businessId we can't safely return a P&L.
  // Returning zeros (rather than throwing) keeps the dashboard widget
  // rendering for system / service-account callers; the FE shows £0 across
  // the board which is the correct signal for "no tenant context". Same
  // pattern getClientPnl uses (returns [] when businessId is missing).
  if (!businessId) {
    return {
      fromDate: fromIso,
      toDate: toIso,
      currency: 'GBP',
      revenue: '0.00',
      fixedCosts: '0.00',
      oneOffCosts: '0.00',
      advertisingCosts: '0.00',
      adSpend: '0.00',
      totalCosts: '0.00',
      netProfit: '0.00',
      margin: '0.0000',
      uncategorisedCount: 0,
      unattributedSpendRows: 0,
    };
  }

  // Revenue = sum(invoices.total) where status='paid' AND createdAt in window.
  // OCT-46: `invoices` has no `business_id` column, so we tenant-scope via
  // INNER JOIN through `clients` (invoices.client_id → clients.business_id),
  // matching the pattern getClientPnl already uses. Without this guard the
  // P&L Summary would sum paid revenue across every tenant in the database
  // the moment a second business is provisioned.
  const [revenueRow] = await db
    .select({ total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)::text` })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(
      and(
        eq(clients.businessId, businessId),
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
