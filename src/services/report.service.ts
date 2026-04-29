import { and, eq, sql, isNull, gte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { clients } from '../db/schema/clients.js';
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
  expenses: number;
  profit: number;
  invoicesPaid: number;
  invoicesOverdue: number;
  vatCollected: number;
}

// ─── Mock generators ───

function generateCampaignReport(): CampaignReportRow[] {
  // All names suffixed " (for demo)" so users can spot mock data immediately
  // if this generator is ever wired back in.
  const campaigns = [
    { id: 'lb-1', name: 'Solar Panel Leads UK (for demo)', client: 'Apex Media Ltd (for demo)', vertical: 'Solar' },
    { id: 'lb-2', name: 'Home Insurance Quotes (for demo)', client: 'Brightfield Corp (for demo)', vertical: 'Insurance' },
    { id: 'lb-3', name: 'Mortgage Leads London (for demo)', client: 'Clearwater Digital (for demo)', vertical: 'Finance' },
    { id: 'lb-4', name: 'Debt Management Leads (for demo)', client: 'Delta Solutions (for demo)', vertical: 'Finance' },
    { id: 'lb-5', name: 'Boiler Installation UK (for demo)', client: 'Apex Media Ltd (for demo)', vertical: 'Home Services' },
    { id: 'lb-6', name: 'Life Insurance Over 50s (for demo)', client: 'Echo Marketing (for demo)', vertical: 'Insurance' },
    { id: 'lb-8', name: 'Personal Injury Claims (for demo)', client: 'Clearwater Digital (for demo)', vertical: 'Legal' },
  ];

  return campaigns.map((c) => {
    const leads = Math.floor(Math.random() * 600) + 200;
    const valid = Math.floor(leads * 0.82);
    const price = [6.50, 8, 12.50, 15, 18, 22, 35][Math.floor(Math.random() * 7)];
    const revenue = valid * price;
    const cost = revenue * (0.35 + Math.random() * 0.2);
    const profit = revenue - cost;
    return {
      campaignId: c.id,
      campaignName: c.name,
      clientName: c.client,
      vertical: c.vertical,
      leads,
      validLeads: valid,
      cost: Math.round(cost * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
      cpl: leads > 0 ? Math.round((cost / leads) * 100) / 100 : 0,
      profit: Math.round(profit * 100) / 100,
      margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
    };
  });
}

function generateClientPnl(): ClientPnlRow[] {
  // All names suffixed " (for demo)" so if this generator is ever wired back
  // into a live endpoint by mistake, the UI immediately signals that the
  // numbers aren't real client revenue.
  const clients = ['Apex Media Ltd (for demo)', 'Brightfield Corp (for demo)', 'Clearwater Digital (for demo)', 'Delta Solutions (for demo)', 'Echo Marketing (for demo)'];
  const rows: ClientPnlRow[] = [];

  for (const client of clients) {
    for (let m = 5; m >= 0; m--) {
      const d = new Date();
      d.setMonth(d.getMonth() - m);
      const month = d.toISOString().slice(0, 7);
      const leads = Math.floor(Math.random() * 300) + 100;
      const revenue = leads * (8 + Math.random() * 20);
      const cost = revenue * (0.35 + Math.random() * 0.15);
      const profit = revenue - cost;
      rows.push({
        clientId: `c-${clients.indexOf(client) + 1}`,
        clientName: client,
        month,
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        margin: Math.round(((revenue - cost) / revenue) * 1000) / 10,
        leadsDelivered: leads,
      });
    }
  }

  return rows;
}

function generateSupplierReport(): SupplierReportRow[] {
  return [
    { supplierId: 's-1', supplierName: 'Google Ads UK (for demo)', platform: 'Google Ads', totalSpend: 14200, totalLeads: 1420, cpl: 10.00, campaigns: 4 },
    { supplierId: 's-2', supplierName: 'Facebook Lead Ads (for demo)', platform: 'Facebook', totalSpend: 8800, totalLeads: 1100, cpl: 8.00, campaigns: 3 },
    { supplierId: 's-3', supplierName: 'LinkedIn Ads (for demo)', platform: 'LinkedIn', totalSpend: 5600, totalLeads: 280, cpl: 20.00, campaigns: 1 },
    { supplierId: 's-4', supplierName: 'Bing Ads (for demo)', platform: 'Bing', totalSpend: 3200, totalLeads: 640, cpl: 5.00, campaigns: 2 },
    { supplierId: 's-5', supplierName: 'TikTok Ads (for demo)', platform: 'TikTok', totalSpend: 1800, totalLeads: 225, cpl: 8.00, campaigns: 1 },
  ];
}

function generateFinancialOverview(): FinancialOverviewRow[] {
  const rows: FinancialOverviewRow[] = [];
  for (let m = 11; m >= 0; m--) {
    const d = new Date();
    d.setMonth(d.getMonth() - m);
    const month = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    const revenue = 25000 + Math.random() * 30000;
    const expenses = revenue * (0.35 + Math.random() * 0.15);
    rows.push({
      month,
      revenue: Math.round(revenue * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      profit: Math.round((revenue - expenses) * 100) / 100,
      invoicesPaid: Math.floor(Math.random() * 15) + 5,
      invoicesOverdue: Math.floor(Math.random() * 4),
      vatCollected: Math.round(revenue * 0.2 * 100) / 100,
    });
  }
  return rows;
}

/**
 * Join LeadByte's campaign report with Sato's campaign metadata
 * (LeadByte doesn't store client/vertical on its end).
 */
// Stale hardcoded mapping from a pre-LeadByte-sync era. Real LeadByte campaign
// names rarely match these keys, so production lookups land on 'Unknown'
// (which is honest). Kept here only as a fallback for the unlikely match;
// labelled " (for demo)" on the off-chance it ever fires.
const CAMPAIGN_META: Record<string, { clientName: string; vertical: string }> = {
  'Solar Panel Leads UK': { clientName: 'Apex Media Ltd (for demo)', vertical: 'Solar' },
  'Home Insurance Quotes': { clientName: 'Brightfield Corp (for demo)', vertical: 'Insurance' },
  'Mortgage Leads London': { clientName: 'Clearwater Digital (for demo)', vertical: 'Finance' },
  'Debt Management Leads': { clientName: 'Delta Solutions (for demo)', vertical: 'Finance' },
  'Boiler Installation UK': { clientName: 'Apex Media Ltd (for demo)', vertical: 'Home Services' },
  'Life Insurance Over 50s': { clientName: 'Echo Marketing (for demo)', vertical: 'Insurance' },
  'Personal Injury Claims': { clientName: 'Clearwater Digital (for demo)', vertical: 'Legal' },
};

// ─── Service ───

export async function getCampaignPerformance(
  _requester: AuthPayload,
  window: DeliveryWindow = 'this_month',
): Promise<CampaignReportRow[]> {
  const rows = await leadbyte.getCampaignReport(window);

  // Empty when LeadByte returns nothing for the window — the UI shows an
  // empty state. Previously fell back to a mock generator which displayed
  // fabricated revenue figures; that's been removed so users never see
  // numbers that aren't real.
  if (rows.length === 0) return [];

  return rows.map((r): CampaignReportRow => {
    const meta = CAMPAIGN_META[r.campaign] ?? { clientName: 'Unknown', vertical: 'Unknown' };
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

export async function getClientPnl(_requester: AuthPayload): Promise<ClientPnlRow[]> {
  // Real query: per-client per-month revenue (sum of paid invoices) + cost
  // (sum of lead-delivery costs) over the last 6 months.
  // Falls back to demo data only if there's nothing in the DB at all.
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
      .where(and(eq(invoices.status, 'paid'), gte(invoices.createdAt, sixMonthsAgo)))
      .groupBy(invoices.clientId, sql`to_char(${invoices.createdAt}, 'YYYY-MM')`),
    db
      .select({
        clientId: leadDeliveries.clientId,
        month: sql<string>`to_char(${leadDeliveries.deliveryDate}, 'YYYY-MM')`,
        cost: sql<string>`coalesce(sum(${leadDeliveries.cost}), 0)`,
        leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
      })
      .from(leadDeliveries)
      .where(gte(leadDeliveries.deliveryDate, sixMonthsAgoIso))
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
  // Real query: last 12 months of revenue (paid invoices), expenses (lead-
  // delivery costs), and invoice status counts per month. This drives the
  // dashboard's revenue-vs-expenses chart.
  // Falls back to demo numbers only if BOTH tables are empty.
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  const twelveMonthsAgoIso = twelveMonthsAgo.toISOString().split('T')[0];

  const [revenueRows, expenseRows, invoiceCountRows] = await Promise.all([
    db
      .select({
        month: sql<string>`to_char(${invoices.createdAt}, 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${invoices.total}), 0)`,
        vat: sql<string>`coalesce(sum(${invoices.vatAmount}), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.status, 'paid'), gte(invoices.createdAt, twelveMonthsAgo)))
      .groupBy(sql`to_char(${invoices.createdAt}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${leadDeliveries.deliveryDate}, 'YYYY-MM')`,
        expenses: sql<string>`coalesce(sum(${leadDeliveries.cost}), 0)`,
      })
      .from(leadDeliveries)
      .where(gte(leadDeliveries.deliveryDate, twelveMonthsAgoIso))
      .groupBy(sql`to_char(${leadDeliveries.deliveryDate}, 'YYYY-MM')`),
    db
      .select({
        month: sql<string>`to_char(${invoices.createdAt}, 'YYYY-MM')`,
        status: invoices.status,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(gte(invoices.createdAt, twelveMonthsAgo))
      .groupBy(sql`to_char(${invoices.createdAt}, 'YYYY-MM')`, invoices.status),
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

  const revenueByMonth = new Map(revenueRows.map((r) => [r.month, { revenue: Number(r.revenue), vat: Number(r.vat) }]));
  const expensesByMonth = new Map(expenseRows.map((r) => [r.month, Number(r.expenses)]));
  const paidByMonth = new Map<string, number>();
  const overdueByMonth = new Map<string, number>();
  for (const c of invoiceCountRows) {
    if (c.status === 'paid') paidByMonth.set(c.month, c.count);
    if (c.status === 'overdue') overdueByMonth.set(c.month, c.count);
  }

  return months.map((m): FinancialOverviewRow => {
    const r = revenueByMonth.get(m) ?? { revenue: 0, vat: 0 };
    const expenses = expensesByMonth.get(m) ?? 0;
    const [year, mm] = m.split('-');
    const monthLabel = new Date(Number(year), Number(mm) - 1, 1).toLocaleDateString('en-GB', {
      month: 'short',
      year: 'numeric',
    });
    return {
      month: monthLabel,
      revenue: Math.round(r.revenue * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      profit: Math.round((r.revenue - expenses) * 100) / 100,
      invoicesPaid: paidByMonth.get(m) ?? 0,
      invoicesOverdue: overdueByMonth.get(m) ?? 0,
      vatCollected: Math.round(r.vat * 100) / 100,
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
  adSpend: string;
  totalCosts: string;
  netProfit: string;
  margin: string; // 0..1 fraction (e.g. "0.42" = 42%)
  uncategorisedCount: number;
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
  let uncategorisedCount = 0;
  for (const row of costByBucket) {
    const amount = parseFloat(row.total) || 0;
    if (row.bucket === 'fixed') fixed += amount;
    else if (row.bucket === 'one_off') oneOff += amount;
    else uncategorisedCount = Math.round(amount); // null bucket = uncategorised; we'll re-count below
  }

  // Re-count uncategorised as a row count (more useful UI signal than a sum)
  const [uncatRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(and(txWhere, isNull(bankTransactions.categoryId)));
  uncategorisedCount = uncatRow?.count ?? 0;

  // Ad spend from Catchr (already a positive number; single-tenant in Phase 1)
  const [adSpendRow] = await db
    .select({ total: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text` })
    .from(adSpend)
    .where(
      and(
        gte(adSpend.date, fromIso),
        lte(adSpend.date, toIso),
      ),
    );

  const revenue = parseFloat(revenueRow?.total ?? '0');
  const adSpendTotal = parseFloat(adSpendRow?.total ?? '0');
  const totalCosts = fixed + oneOff + adSpendTotal;
  const netProfit = revenue - totalCosts;
  const margin = revenue > 0 ? netProfit / revenue : 0;

  return {
    fromDate: fromIso,
    toDate: toIso,
    currency: 'GBP',
    revenue: revenue.toFixed(2),
    fixedCosts: fixed.toFixed(2),
    oneOffCosts: oneOff.toFixed(2),
    adSpend: adSpendTotal.toFixed(2),
    totalCosts: totalCosts.toFixed(2),
    netProfit: netProfit.toFixed(2),
    margin: margin.toFixed(4),
    uncategorisedCount,
  };
}
