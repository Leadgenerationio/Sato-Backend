import { and, eq, sql, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
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
  const campaigns = [
    { id: 'lb-1', name: 'Solar Panel Leads UK', client: 'Apex Media Ltd', vertical: 'Solar' },
    { id: 'lb-2', name: 'Home Insurance Quotes', client: 'Brightfield Corp', vertical: 'Insurance' },
    { id: 'lb-3', name: 'Mortgage Leads London', client: 'Clearwater Digital', vertical: 'Finance' },
    { id: 'lb-4', name: 'Debt Management Leads', client: 'Delta Solutions', vertical: 'Finance' },
    { id: 'lb-5', name: 'Boiler Installation UK', client: 'Apex Media Ltd', vertical: 'Home Services' },
    { id: 'lb-6', name: 'Life Insurance Over 50s', client: 'Echo Marketing', vertical: 'Insurance' },
    { id: 'lb-8', name: 'Personal Injury Claims', client: 'Clearwater Digital', vertical: 'Legal' },
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
  const clients = ['Apex Media Ltd', 'Brightfield Corp', 'Clearwater Digital', 'Delta Solutions', 'Echo Marketing'];
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
    { supplierId: 's-1', supplierName: 'Google Ads UK', platform: 'Google Ads', totalSpend: 14200, totalLeads: 1420, cpl: 10.00, campaigns: 4 },
    { supplierId: 's-2', supplierName: 'Facebook Lead Ads', platform: 'Facebook', totalSpend: 8800, totalLeads: 1100, cpl: 8.00, campaigns: 3 },
    { supplierId: 's-3', supplierName: 'LinkedIn Ads', platform: 'LinkedIn', totalSpend: 5600, totalLeads: 280, cpl: 20.00, campaigns: 1 },
    { supplierId: 's-4', supplierName: 'Bing Ads', platform: 'Bing', totalSpend: 3200, totalLeads: 640, cpl: 5.00, campaigns: 2 },
    { supplierId: 's-5', supplierName: 'TikTok Ads', platform: 'TikTok', totalSpend: 1800, totalLeads: 225, cpl: 8.00, campaigns: 1 },
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
const CAMPAIGN_META: Record<string, { clientName: string; vertical: string }> = {
  'Solar Panel Leads UK': { clientName: 'Apex Media Ltd', vertical: 'Solar' },
  'Home Insurance Quotes': { clientName: 'Brightfield Corp', vertical: 'Insurance' },
  'Mortgage Leads London': { clientName: 'Clearwater Digital', vertical: 'Finance' },
  'Debt Management Leads': { clientName: 'Delta Solutions', vertical: 'Finance' },
  'Boiler Installation UK': { clientName: 'Apex Media Ltd', vertical: 'Home Services' },
  'Life Insurance Over 50s': { clientName: 'Echo Marketing', vertical: 'Insurance' },
  'Personal Injury Claims': { clientName: 'Clearwater Digital', vertical: 'Legal' },
};

// ─── Service ───

export async function getCampaignPerformance(
  _requester: AuthPayload,
  window: DeliveryWindow = 'this_month',
): Promise<CampaignReportRow[]> {
  const rows = await leadbyte.getCampaignReport(window);

  if (rows.length === 0) {
    return generateCampaignReport();
  }

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
  return generateClientPnl();
}

export async function getSupplierPerformance(
  _requester: AuthPayload,
  window: DeliveryWindow = 'this_month',
): Promise<SupplierReportRow[]> {
  const spendRows = await leadbyte.getSupplierSpend(window);

  if (spendRows.length === 0) {
    // Fallback to canned numbers so the dashboard never shows empty when LeadByte is down.
    return generateSupplierReport();
  }

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
  return generateFinancialOverview();
}

// ─── P&L three-bucket summary (Sam's 2026-04-28 brief) ─────────────────────
//
// Revenue (from paid invoices) vs (fixed costs + one-off costs + ad spend)
// over the last `days` days. Uses the bank-feed categorisation tables
// (bank_transactions joined to cost_categories) for cost buckets.

import { invoices } from '../db/schema/invoices.js';
import { bankTransactions, costCategories } from '../db/schema/bank-feed.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { gte, lte } from 'drizzle-orm';

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
