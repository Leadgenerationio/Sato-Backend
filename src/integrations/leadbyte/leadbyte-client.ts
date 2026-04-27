import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  LeadByteCampaign,
  LeadByteCampaignRaw,
  LeadByteCampaignDetail,
  LeadByteDeliveryReport,
  LeadByteSupplier,
  LeadByteSupplierSpend,
  LeadByteSupplierReportRow,
  LeadByteCampaignReportRow,
  LeadByteLeadActivityRow,
  LeadByteLeadDetail,
  LeadByteLeadUpdateItem,
  LeadByteSearch,
  LeadByteFeedbackInput,
  LeadByteInternalFeedbackInput,
  LeadByteAssignBuyerInput,
  LeadBytePingInput,
  LeadByteDelivery,
  LeadByteDeliveryCreateInput,
  LeadByteDeliveryUpdate,
  LeadByteResponder,
  LeadByteQueueItem,
  LeadByteLeadFinancialsInput,
  LeadByteMessagingReportRow,
  LeadByteBuyerReportRow,
  LeadByteCreditInput,
  LeadByteBuyer,
  LeadByteBuyerCreateInput,
  LeadByteBuyerUpdate,
  LeadByteQuarantineInput,
  DeliveryWindow,
  LeadBytePreset,
} from './leadbyte-types.js';

// ─── Config ─────────────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return !!process.env.LEADBYTE_API_KEY;
}

export function isLeadByteConfigured(): boolean {
  return isConfigured();
}

function apiKey(): string {
  return process.env.LEADBYTE_API_KEY || '';
}

function baseUrl(): string {
  return (
    process.env.LEADBYTE_BASE_URL ||
    env.LEADBYTE_BASE_URL ||
    'https://clinical.leadbyte.co.uk/restapi/v1.3'
  ).replace(/\/$/, '');
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

/** GET — auth via `?key=` query param per LeadByte docs. */
async function lbGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams({ key: apiKey() });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${baseUrl()}${path}?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, path, body }, 'LeadByte GET failed');
    throw new Error(`LeadByte GET ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** POST/PUT — auth via `X_KEY` header per LeadByte docs. */
async function lbWrite<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'X_KEY': apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, path, err }, `LeadByte ${method} failed`);
    throw new Error(`LeadByte ${method} ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** GET with body — used by /apiqueue and /leads for batch lookups per LeadByte docs. */
async function lbGetBody<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: apiKey(), ...body }),
  });
  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, path, err }, 'LeadByte GET(body) failed');
    throw new Error(`LeadByte GET ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function requireConfigured(op: string): void {
  if (!isConfigured()) throw new Error(`LeadByte not configured — cannot ${op}`);
}

// ─── Response normalisers ───────────────────────────────────────────────────

/**
 * LeadByte's /reports/* endpoints return `{status, message, data, benchmark}`.
 * Older mocked responses used `{report: [...]}`. Accept either shape and
 * fall through to `[]` so callers always get an array.
 */
function unwrapReport<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = res as { data?: unknown; report?: unknown };
  if (Array.isArray(r?.data)) return r.data as T[];
  if (Array.isArray(r?.report)) return r.report as T[];
  return [];
}

/**
 * Report rows often nest `campaign`, `supplier`, or `buyer` as `{id, name, reference}`
 * objects rather than the flat strings the client docs imply. Pull out a printable
 * identifier so downstream typed `string` fields stay valid.
 */
function flatRef(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as { name?: unknown; id?: unknown };
    if (typeof o.name === 'string') return o.name;
    if (typeof o.id === 'string' || typeof o.id === 'number') return String(o.id);
  }
  return '';
}

/** Pick the id off a `{id, name, reference}` ref object (or echo a flat string id). */
function refId(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as { id?: unknown };
    if (typeof o.id === 'string' || typeof o.id === 'number') return String(o.id);
  }
  return '';
}

/**
 * LeadByte returns currency as a long human-readable label
 * ("Britain (United Kingdom), Pounds") rather than ISO 4217. Map the common
 * cases back to ISO codes so frontend formatters work.
 */
function toIsoCurrency(s: string | undefined | null): string {
  if (!s) return 'GBP';
  const trimmed = s.trim();
  if (/^[A-Z]{3}$/.test(trimmed)) return trimmed; // already ISO
  if (/pound|sterling|gbp|united kingdom|britain/i.test(trimmed)) return 'GBP';
  if (/euro|eur/i.test(trimmed)) return 'EUR';
  if (/dollar|usd|united states/i.test(trimmed)) return 'USD';
  if (/dollar|aud|australia/i.test(trimmed)) return 'AUD';
  if (/dollar|cad|canada/i.test(trimmed)) return 'CAD';
  return 'GBP';
}

// ─── Window translation ─────────────────────────────────────────────────────

/**
 * Map our DeliveryWindow (matches Sam's handover sheet) to LeadByte's `datePreset`.
 * LeadByte doesn't have a `ytd` preset — we return undefined and the caller falls
 * back to explicit `from`/`to` ISO timestamps.
 */
export function windowToPreset(win: DeliveryWindow): LeadBytePreset | undefined {
  switch (win) {
    case 'today': return 'today';
    case 'yesterday': return 'yesterday';
    case 'this_week': return 'this_week';
    case 'last_week': return 'lastweek'; // LeadByte uses one-word spelling
    case 'this_month': return 'this_month';
    case 'last_month': return 'last_month';
    case 'ytd': return undefined;
  }
}

/** Build ISO 8601 from/to for a window, used when datePreset isn't available. */
export function windowToRange(win: DeliveryWindow): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

  const today = startOfDay(now);
  const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1; // Mon=0..Sun=6

  switch (win) {
    case 'today':
      return { from: iso(today), to: iso(now) };
    case 'yesterday': {
      const y = new Date(today.getTime() - 86400000);
      return { from: iso(y), to: iso(endOfDay(y)) };
    }
    case 'this_week': {
      const start = new Date(today.getTime() - dayOfWeek * 86400000);
      return { from: iso(start), to: iso(now) };
    }
    case 'last_week': {
      const endLast = new Date(today.getTime() - (dayOfWeek + 1) * 86400000);
      const startLast = new Date(endLast.getTime() - 6 * 86400000);
      return { from: iso(startOfDay(startLast)), to: iso(endOfDay(endLast)) };
    }
    case 'this_month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      return { from: iso(start), to: iso(end) };
    }
    case 'ytd':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
  }
}

/** Both as query params. Preset is preferred when supported; otherwise ISO range. */
function windowToQuery(win: DeliveryWindow): Record<string, string> {
  const preset = windowToPreset(win);
  if (preset) return { datePreset: preset };
  const { from, to } = windowToRange(win);
  return { from, to };
}

// ─── Mock data (fallback when LEADBYTE_API_KEY not set) ─────────────────────

const MOCK_CAMPAIGNS: LeadByteCampaign[] = [
  { id: 'lb-1', name: 'Solar Panel Leads UK', clientId: 'c-1', clientName: 'Apex Media Ltd', vertical: 'Solar', status: 'active', leadPrice: 12.50, currency: 'GBP', startDate: '2025-09-01' },
  { id: 'lb-2', name: 'Home Insurance Quotes', clientId: 'c-2', clientName: 'Brightfield Corp', vertical: 'Insurance', status: 'active', leadPrice: 8.00, currency: 'GBP', startDate: '2025-10-15' },
  { id: 'lb-3', name: 'Mortgage Leads London', clientId: 'c-3', clientName: 'Clearwater Digital', vertical: 'Finance', status: 'active', leadPrice: 22.00, currency: 'GBP', startDate: '2025-11-01' },
  { id: 'lb-4', name: 'Debt Management Leads', clientId: 'c-4', clientName: 'Delta Solutions', vertical: 'Finance', status: 'paused', leadPrice: 15.00, currency: 'GBP', startDate: '2025-08-20' },
  { id: 'lb-5', name: 'Boiler Installation UK', clientId: 'c-1', clientName: 'Apex Media Ltd', vertical: 'Home Services', status: 'active', leadPrice: 18.00, currency: 'GBP', startDate: '2026-01-10' },
  { id: 'lb-6', name: 'Life Insurance Over 50s', clientId: 'c-5', clientName: 'Echo Marketing', vertical: 'Insurance', status: 'active', leadPrice: 6.50, currency: 'GBP', startDate: '2025-12-01' },
  { id: 'lb-7', name: 'EV Charging Installers', clientId: 'c-2', clientName: 'Brightfield Corp', vertical: 'Solar', status: 'inactive', leadPrice: 20.00, currency: 'GBP', startDate: '2025-07-01' },
  { id: 'lb-8', name: 'Personal Injury Claims', clientId: 'c-3', clientName: 'Clearwater Digital', vertical: 'Legal', status: 'active', leadPrice: 35.00, currency: 'GBP', startDate: '2026-02-01' },
];

function generateMockDeliveries(campaignId: string, days: number): LeadByteDeliveryReport[] {
  const deliveries: LeadByteDeliveryReport[] = [];
  const campaign = MOCK_CAMPAIGNS.find((c) => c.id === campaignId);
  const price = campaign?.leadPrice ?? 10;

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const leads = Math.floor(Math.random() * 40) + 5;
    const revenue = leads * price;
    const cost = revenue * (0.35 + Math.random() * 0.2);

    deliveries.push({
      campaignId,
      date: date.toISOString().split('T')[0],
      leadCount: leads,
      validLeads: leads,
      invalidLeads: 0,
      revenue: Math.round(revenue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      reportId: `rpt-${campaignId}-${i}`,
    });
  }

  return deliveries.reverse();
}

const MOCK_SUPPLIERS: LeadByteSupplier[] = [
  { id: 's-1', name: 'Google Ads UK', platform: 'Google Ads', accountId: 'gads-001', campaignId: 'lb-1', totalSpend: 4200, totalLeads: 420 },
  { id: 's-2', name: 'Facebook Lead Ads', platform: 'Facebook', accountId: 'fb-001', campaignId: 'lb-1', totalSpend: 2800, totalLeads: 310 },
  { id: 's-3', name: 'LinkedIn Ads', platform: 'LinkedIn', accountId: 'li-001', campaignId: 'lb-3', totalSpend: 5600, totalLeads: 180 },
  { id: 's-4', name: 'Bing Ads', platform: 'Bing', accountId: 'bing-001', campaignId: 'lb-2', totalSpend: 1200, totalLeads: 200 },
  { id: 's-5', name: 'Google Ads Insurance', platform: 'Google Ads', accountId: 'gads-002', campaignId: 'lb-2', totalSpend: 3500, totalLeads: 480 },
  { id: 's-6', name: 'Facebook Finance', platform: 'Facebook', accountId: 'fb-002', campaignId: 'lb-3', totalSpend: 3200, totalLeads: 220 },
  { id: 's-7', name: 'TikTok Solar', platform: 'TikTok', accountId: 'tt-001', campaignId: 'lb-5', totalSpend: 1800, totalLeads: 150 },
  { id: 's-8', name: 'Google Legal', platform: 'Google Ads', accountId: 'gads-003', campaignId: 'lb-8', totalSpend: 8400, totalLeads: 240 },
];

// ─── Normalisers ────────────────────────────────────────────────────────────

function normaliseCampaign(raw: LeadByteCampaignRaw): LeadByteCampaign {
  const active = raw.active === 'Yes' || raw.active === true;
  const archived = raw.archived === 'Yes' || raw.archived === true;
  const status: LeadByteCampaign['status'] = archived ? 'inactive' : active ? 'active' : 'paused';
  return {
    id: String(raw.id),
    name: raw.name,
    reference: raw.reference,
    // These four are not part of LeadByte's response — enrich from Sato DB later.
    clientId: '',
    clientName: '',
    vertical: '',
    leadPrice: 0,
    currency: toIsoCurrency(raw.currency),
    status,
    startDate: '',
  };
}

// ─── Public client API ──────────────────────────────────────────────────────

/**
 * `GET /campaigns` — returns raw LeadByte campaigns.
 * Note: client/vertical/leadPrice/startDate must be enriched from Sato's own DB;
 * LeadByte's endpoint does not include those.
 */
export async function getCampaigns(statusFilter?: 'Active' | 'Inactive' | 'Archived'): Promise<LeadByteCampaign[]> {
  if (!isConfigured()) {
    logger.warn('LeadByte running in MOCK mode — no LEADBYTE_API_KEY configured');
    return MOCK_CAMPAIGNS;
  }
  // Configured: real call. Throw on API errors (was silently falling back to
  // mocks, which hid auth problems — discovered when a partial-perm key
  // returned mock data instead of failing). Caller's error handler decides UX.
  const raws = await lbGet<LeadByteCampaignRaw[]>('/campaigns', { status: statusFilter });
  return raws.map(normaliseCampaign);
}

/**
 * Per-day delivery report for a single campaign.
 * Uses `GET /reports/leadactivity` (groupBy=day, showData=leads) and joins with
 * `/reports/campaign` to get revenue/cost totals.
 *
 * Sam doesn't want invalid splits, so validLeads = leadCount and invalidLeads = 0.
 */
export async function getDeliveryReports(
  campaignId: string,
  windowOrDays: DeliveryWindow | number = 30,
): Promise<LeadByteDeliveryReport[]> {
  if (!isConfigured()) {
    if (typeof windowOrDays === 'number') {
      return generateMockDeliveries(campaignId, windowOrDays);
    }
    const range = windowToRange(windowOrDays);
    const full = generateMockDeliveries(campaignId, 365);
    return full.filter((d) => d.date >= range.from.slice(0, 10) && d.date <= range.to.slice(0, 10));
  }

  const dateQuery =
    typeof windowOrDays === 'number'
      ? (() => {
          const to = new Date();
          const from = new Date(to.getTime() - windowOrDays * 86400000);
          return { from: from.toISOString(), to: to.toISOString() };
        })()
      : windowToQuery(windowOrDays);

  const activity = await lbGet<unknown>('/reports/leadactivity', {
    campaignId,
    groupBy: 'day',
    showData: 'leads',
    ...dateQuery,
  });
  // Approximate revenue/cost using mock pricing since LeadByte /reports/leadactivity returns count only.
  // For totals use /reports/campaign in report.service.ts.
  return unwrapReport<LeadByteLeadActivityRow>(activity).map((r) => ({
    campaignId,
    date: r.date,
    leadCount: r.count,
    validLeads: r.count,
    invalidLeads: 0,
    revenue: 0,
    cost: 0,
    reportId: `lb-${campaignId}-${r.date}`,
  }));
}

/**
 * List suppliers. LeadByte has no standalone /suppliers endpoint — we derive the list
 * from `GET /reports/supplier` aggregated over the last 30 days.
 */
export async function getSuppliers(campaignId?: string): Promise<LeadByteSupplier[]> {
  if (!isConfigured()) {
    return campaignId ? MOCK_SUPPLIERS.filter((s) => s.campaignId === campaignId) : MOCK_SUPPLIERS;
  }
  const rows = await lbGet<unknown>('/reports/supplier', {
    campaignId: campaignId || 'all',
    datePreset: 'last_30d',
    groupBy: 'campaign',
    showSupplier: 'Yes',
  });
  return unwrapReport<LeadByteSupplierReportRow>(rows).map((r, i) => {
    const supplierName = flatRef(r.supplier);
    return {
      id: `lb-sup-${i}`,
      name: supplierName,
      platform: supplierName,
      accountId: supplierName,
      campaignId: refId(r.campaign) || flatRef(r.campaign),
      totalSpend: r.payout,
      totalLeads: r.leads,
    };
  });
}

/**
 * Supplier-level spend breakdown for a given window.
 * Uses `GET /reports/supplier` — `payout` field = what we pay the supplier = Sam's "spend".
 */
export async function getSupplierSpend(window: DeliveryWindow): Promise<LeadByteSupplierSpend[]> {
  if (!isConfigured()) {
    const factor = windowFactor(window);
    return MOCK_SUPPLIERS.map((s) => {
      const campaign = MOCK_CAMPAIGNS.find((c) => c.id === s.campaignId);
      const spend = Math.round(s.totalSpend * factor * 100) / 100;
      const leads = Math.round(s.totalLeads * factor);
      return {
        supplierId: s.id,
        supplierName: s.name,
        platform: s.platform,
        campaignId: s.campaignId,
        campaignName: campaign?.name ?? 'Unknown',
        window,
        spend,
        leads,
        cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0,
      };
    });
  }

  const res = await lbGet<unknown>('/reports/supplier', {
    campaignId: 'all',
    groupBy: 'campaign',
    showSupplier: 'Yes',
    ...windowToQuery(window),
  });
  return unwrapReport<LeadByteSupplierReportRow>(res).map((r, i): LeadByteSupplierSpend => {
    const supplierName = flatRef(r.supplier);
    const campaignName = flatRef(r.campaign);
    return {
      supplierId: `lb-sup-${i}-${supplierName}`,
      supplierName,
      platform: supplierName,
      campaignId: refId(r.campaign) || campaignName,
      campaignName,
      window,
      spend: r.payout,
      leads: r.leads,
      cpl: r.eCPL ?? (r.leads > 0 ? Math.round((r.payout / r.leads) * 100) / 100 : 0),
    };
  });
}

/**
 * `GET /reports/campaign` — per-campaign summary (leads, revenue, payout, profit).
 * groupBy=campaign so one row per campaign.
 */
export async function getCampaignReport(window: DeliveryWindow): Promise<LeadByteCampaignReportRow[]> {
  if (!isConfigured()) {
    const factor = windowFactor(window);
    return MOCK_CAMPAIGNS.filter((c) => c.status !== 'inactive').map((c) => {
      const leads = Math.floor((Math.random() * 600 + 200) * factor);
      const valid = Math.floor(leads * 0.85);
      const revenue = valid * c.leadPrice;
      const payout = revenue * (0.35 + Math.random() * 0.2);
      return {
        campaign: c.name,
        leads,
        valid,
        invalid: leads - valid,
        pending: 0,
        rejections: 0,
        payable: valid,
        sold: valid,
        returns: 0,
        payout: Math.round(payout * 100) / 100,
        revenue: Math.round(revenue * 100) / 100,
        profit: Math.round((revenue - payout) * 100) / 100,
        currency: c.currency,
      };
    });
  }
  const res = await lbGet<unknown>('/reports/campaign', {
    campaignId: 'all',
    groupBy: 'campaign',
    showCampaign: 'Yes',
    ...windowToQuery(window),
  });
  return unwrapReport<LeadByteCampaignReportRow & { campaign: unknown }>(res).map(
    (r): LeadByteCampaignReportRow => ({
      ...r,
      campaign: flatRef(r.campaign),
      currency: toIsoCurrency(r.currency as string | undefined),
    }),
  );
}

function windowFactor(win: DeliveryWindow): number {
  switch (win) {
    case 'today': return 0.03;
    case 'yesterday': return 0.03;
    case 'this_week': return 0.2;
    case 'last_week': return 0.2;
    case 'this_month': return 0.8;
    case 'last_month': return 1;
    case 'ytd': return 3;
  }
}

// ─── Write endpoints (stubs for lead submission, return, feedback) ──────────

export async function submitLead(lead: Record<string, unknown>): Promise<unknown> {
  if (!isConfigured()) throw new Error('LeadByte not configured — cannot submit lead');
  return lbWrite('POST', '/leads', lead);
}

export async function returnLead(args: { leadId?: string | number; leadIds?: Array<string | number>; BID: string; reason: string }): Promise<unknown> {
  if (!isConfigured()) throw new Error('LeadByte not configured — cannot return lead');
  return lbWrite('POST', '/leads/return', { key: apiKey(), ...args });
}

// ─── Mock data for buyers/deliveries/responders (no-key dev mode) ───────────

const MOCK_BUYERS = [
  { id: 1, company: 'Solar Savings UK', bid: 'BUY-SSUK', status: 'Active' as const, credit_amount: 5000, credit_balance: 3200, phone: '020 1234 5678', postcode: 'EC1A 1AA' },
  { id: 2, company: 'Insurance Hub Ltd', bid: 'BUY-INSH', status: 'Active' as const, credit_amount: 10000, credit_balance: 7450, phone: '0161 555 0100', postcode: 'M1 4BT' },
  { id: 3, company: 'Finance First', bid: 'BUY-FF', status: 'Active' as const, credit_amount: 8000, credit_balance: 1200, phone: '0113 222 3333', postcode: 'LS1 5QS' },
  { id: 4, company: 'Home Services Group', bid: 'BUY-HSG', status: 'Inactive' as const, credit_amount: 2500, credit_balance: 0, phone: '0117 900 1122', postcode: 'BS1 4DJ' },
  { id: 5, company: 'Legal Partners UK', bid: 'BUY-LPUK', status: 'Active' as const, credit_amount: 15000, credit_balance: 11800, phone: '0207 444 5678', postcode: 'WC2B 4HH' },
];

const MOCK_DELIVERIES = [
  { id: 101, reference: 'DEL-SOLAR-01', status: 'Active' as const, campaign: { id: 'lb-1', name: 'Solar Panel Leads UK' }, deliver_to: 'Direct Post' as const, buyer: { id: 1, name: 'Solar Savings UK', bid: 'BUY-SSUK' } },
  { id: 102, reference: 'DEL-INSURE-01', status: 'Active' as const, campaign: { id: 'lb-2', name: 'Home Insurance Quotes' }, deliver_to: 'Email' as const, buyer: { id: 2, name: 'Insurance Hub Ltd', bid: 'BUY-INSH' } },
  { id: 103, reference: 'DEL-MORTG-01', status: 'Active' as const, campaign: { id: 'lb-3', name: 'Mortgage Leads London' }, deliver_to: 'Direct Post' as const, buyer: { id: 3, name: 'Finance First', bid: 'BUY-FF' } },
  { id: 104, reference: 'DEL-BOILER-SMS', status: 'Inactive' as const, campaign: { id: 'lb-5', name: 'Boiler Installation UK' }, deliver_to: 'SMS' as const, buyer: { id: 4, name: 'Home Services Group', bid: 'BUY-HSG' } },
  { id: 105, reference: 'DEL-LEGAL-01', status: 'Active' as const, campaign: { id: 'lb-8', name: 'Personal Injury Claims' }, deliver_to: 'Direct Post' as const, buyer: { id: 5, name: 'Legal Partners UK', bid: 'BUY-LPUK' } },
  { id: 106, reference: 'DEL-LIFE-STORE', status: 'Saved' as const, campaign: { id: 'lb-6', name: 'Life Insurance Over 50s' }, deliver_to: 'Store Lead' as const, buyer: { id: 2, name: 'Insurance Hub Ltd', bid: 'BUY-INSH' } },
];

const MOCK_RESPONDERS = [
  {
    id: 201,
    reference: 'RES-WELCOME-SOLAR',
    status: 'Active',
    campaign: { id: 'lb-1', name: 'Solar Panel Leads UK' },
    pushes: [
      { push_id: 1, name: 'Day 0 — Welcome', sent: 1200, delivered: 1150, clicks: 340, conversions: 42, cost: 120, revenue: 520, profit: 400, active: true },
      { push_id: 2, name: 'Day 3 — Reminder', sent: 890, delivered: 870, clicks: 210, conversions: 18, cost: 89, revenue: 216, profit: 127, active: true },
    ],
  },
  {
    id: 202,
    reference: 'RES-INSURE-FLOW',
    status: 'Active',
    campaign: { id: 'lb-2', name: 'Home Insurance Quotes' },
    pushes: [
      { push_id: 3, name: 'Quote Reminder', sent: 2100, delivered: 2080, clicks: 410, conversions: 64, cost: 210, revenue: 512, profit: 302, active: true },
    ],
  },
  {
    id: 203,
    reference: 'RES-FIN-WARMUP',
    status: 'Paused',
    campaign: { id: 'lb-3', name: 'Mortgage Leads London' },
    pushes: [
      { push_id: 4, name: 'Mortgage Tips', sent: 450, delivered: 440, clicks: 88, conversions: 6, cost: 45, revenue: 132, profit: 87, active: false },
    ],
  },
];

function logMock(scope: string): void {
  logger.warn(`LeadByte ${scope} — returning mocks (LEADBYTE_API_KEY not configured)`);
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

export async function getCampaignById(id: string | number): Promise<LeadByteCampaignDetail> {
  if (!isConfigured()) {
    logMock(`getCampaignById(${id})`);
    return { id: String(id), name: 'Mock Campaign', reference: `MOCK-${id}`, active: 'Yes', fields: [] };
  }
  return lbGet<LeadByteCampaignDetail>(`/campaigns/${id}`);
}

// ─── Leads ──────────────────────────────────────────────────────────────────

export async function submitLeads(leads: Array<Record<string, unknown>>): Promise<unknown> {
  requireConfigured('submit leads batch');
  return lbWrite('POST', '/leads', { leads });
}

export async function getLeadById(id: string | number): Promise<LeadByteLeadDetail> {
  requireConfigured('get lead');
  return lbGet<LeadByteLeadDetail>(`/leads/${id}`);
}

export async function getLeadsBatch(leadIds: Array<string | number>): Promise<LeadByteLeadDetail[]> {
  requireConfigured('get leads batch');
  return lbGetBody<LeadByteLeadDetail[]>('/leads', { leadIds });
}

export async function updateLeads(leads: LeadByteLeadUpdateItem[]): Promise<unknown> {
  requireConfigured('update leads');
  return lbWrite('PUT', '/leads', { leads });
}

export async function searchLeads(args: {
  searches: LeadByteSearch[];
  callback?: string;
  searchPeriod?: number;
  extrafields?: string[];
}): Promise<unknown> {
  requireConfigured('search leads');
  return lbWrite('POST', '/leads/search', { key: apiKey(), ...args });
}

export async function addLeadFeedback(args: LeadByteFeedbackInput): Promise<unknown> {
  requireConfigured('add lead feedback');
  return lbWrite('PUT', '/leads/feedback', { key: apiKey(), ...args });
}

export async function addLeadInternalFeedback(args: LeadByteInternalFeedbackInput): Promise<unknown> {
  requireConfigured('add internal feedback');
  return lbWrite('PUT', '/leads/internalfeedback', { key: apiKey(), ...args });
}

export async function reprocessLeads(args: { leadId?: string | number; leadIds?: Array<string | number> }): Promise<unknown> {
  requireConfigured('reprocess leads');
  return lbWrite('POST', '/leads/reprocess', args);
}

export async function assignBuyer(args: LeadByteAssignBuyerInput): Promise<unknown> {
  requireConfigured('assign buyer');
  return lbWrite('POST', '/leads/assignbuyer', args);
}

export async function pingLead(args: LeadBytePingInput): Promise<unknown> {
  requireConfigured('ping lead');
  return lbWrite('POST', '/leads/ping', args);
}

export async function deliveryChecker(args: {
  lead?: Record<string, unknown>;
  leads?: Array<Record<string, unknown>>;
  extrafields?: string[];
}): Promise<unknown> {
  requireConfigured('check deliveries');
  return lbWrite('POST', '/leads/deliverychecker', { key: apiKey(), ...args });
}

// ─── Deliveries ─────────────────────────────────────────────────────────────

export async function createDelivery(input: LeadByteDeliveryCreateInput): Promise<unknown> {
  requireConfigured('create delivery');
  return lbWrite('POST', '/deliveries/create', input);
}

export async function getDeliveries(filter?: {
  status?: 'Active' | 'Inactive' | 'Saved';
  buyerid?: number;
  bid?: string;
}): Promise<LeadByteDelivery[]> {
  if (!isConfigured()) {
    logMock('getDeliveries');
    return filter?.status ? MOCK_DELIVERIES.filter((d) => d.status === filter.status) : MOCK_DELIVERIES;
  }
  return lbGet<LeadByteDelivery[]>('/deliveries', filter as Record<string, string | number | undefined>);
}

export async function getDeliveryById(id: string | number): Promise<LeadByteDelivery> {
  if (!isConfigured()) {
    logMock(`getDeliveryById(${id})`);
    const hit = MOCK_DELIVERIES.find((d) => String(d.id) === String(id));
    return hit ?? MOCK_DELIVERIES[0];
  }
  return lbGet<LeadByteDelivery>(`/deliveries/${id}`);
}

export async function updateDeliveries(deliveries: Array<{ id: string | number; update: LeadByteDeliveryUpdate }>): Promise<unknown> {
  requireConfigured('update deliveries');
  return lbWrite('PUT', '/deliveries', { key: apiKey(), deliveries });
}

export async function updateDeliveryById(id: string | number, update: LeadByteDeliveryUpdate): Promise<unknown> {
  requireConfigured('update delivery');
  return lbWrite('PUT', `/deliveries/${id}`, { key: apiKey(), update });
}

export async function triggerDeliveries(args: {
  leadId?: string | number;
  leads?: Array<string | number>;
  deliveryId?: string | number;
  deliveries?: Array<string | number>;
}): Promise<unknown> {
  requireConfigured('trigger deliveries');
  return lbWrite('POST', '/deliveries/trigger', { key: apiKey(), ...args });
}

// ─── Responders ─────────────────────────────────────────────────────────────

export async function getResponders(): Promise<LeadByteResponder[]> {
  if (!isConfigured()) {
    logMock('getResponders');
    return MOCK_RESPONDERS;
  }
  return lbGet<LeadByteResponder[]>('/responders');
}

export async function getResponderById(id: string | number): Promise<LeadByteResponder> {
  if (!isConfigured()) {
    logMock(`getResponderById(${id})`);
    const hit = MOCK_RESPONDERS.find((r) => String(r.id) === String(id));
    return hit ?? MOCK_RESPONDERS[0];
  }
  return lbGet<LeadByteResponder>(`/responders/${id}`);
}

// ─── API Queue ──────────────────────────────────────────────────────────────

export async function getQueueItem(queueRef: string): Promise<LeadByteQueueItem> {
  requireConfigured('get queue item');
  return lbGet<LeadByteQueueItem>(`/apiqueue/${queueRef}`);
}

export async function getQueueItemsBatch(queueIds: string[]): Promise<LeadByteQueueItem[]> {
  requireConfigured('get queue items batch');
  return lbGetBody<LeadByteQueueItem[]>('/apiqueue', { queueIds });
}

// ─── Lead Financials ────────────────────────────────────────────────────────

export async function updateLeadFinancials(input: LeadByteLeadFinancialsInput): Promise<unknown> {
  requireConfigured('update lead financials');
  return lbWrite('PUT', '/leadfinancials', { key: apiKey(), ...input });
}

// ─── Reports (email/sms/bulk/buyer) ─────────────────────────────────────────

interface ReportParams {
  campaignId: string | number | string;
  from?: string;
  to?: string;
  window?: DeliveryWindow;
  groupBy?: string;
  supplierId?: string | number;
  responderId?: string | number;
  buyerId?: string | number;
  showSupplier?: 'Yes' | 'No';
  showSSID?: 'Yes' | 'No';
  showBuyer?: 'Yes' | 'No';
  leadTypeAPI?: 'Yes' | 'No';
  leadTypeImport?: 'Yes' | 'No';
}

function buildReportQuery(p: ReportParams): Record<string, string | number | undefined> {
  const { window, ...rest } = p;
  const base: Record<string, string | number | undefined> = {
    campaignId: String(rest.campaignId),
    groupBy: rest.groupBy,
    supplierId: rest.supplierId !== undefined ? String(rest.supplierId) : undefined,
    responderId: rest.responderId !== undefined ? String(rest.responderId) : undefined,
    buyerId: rest.buyerId !== undefined ? String(rest.buyerId) : undefined,
    showSupplier: rest.showSupplier,
    showSSID: rest.showSSID,
    showBuyer: rest.showBuyer,
    leadTypeAPI: rest.leadTypeAPI,
    leadTypeImport: rest.leadTypeImport,
  };
  if (window) Object.assign(base, windowToQuery(window));
  else if (rest.from && rest.to) { base.from = rest.from; base.to = rest.to; }
  return base;
}

function normaliseMessagingRow(r: LeadByteMessagingReportRow & { campaign: unknown; supplier?: unknown; responder?: unknown }): LeadByteMessagingReportRow {
  return {
    ...r,
    campaign: flatRef(r.campaign),
    supplier: r.supplier !== undefined ? flatRef(r.supplier) : undefined,
    responder: r.responder !== undefined ? flatRef(r.responder) : undefined,
    currency: toIsoCurrency(r.currency as string | undefined),
  };
}

export async function getEmailReport(params: ReportParams): Promise<LeadByteMessagingReportRow[]> {
  requireConfigured('get email report');
  const res = await lbGet<unknown>('/reports/email', buildReportQuery(params));
  return unwrapReport<LeadByteMessagingReportRow & { campaign: unknown }>(res).map(normaliseMessagingRow);
}

export async function getSmsReport(params: ReportParams): Promise<LeadByteMessagingReportRow[]> {
  requireConfigured('get sms report');
  const res = await lbGet<unknown>('/reports/sms', buildReportQuery(params));
  return unwrapReport<LeadByteMessagingReportRow & { campaign: unknown }>(res).map(normaliseMessagingRow);
}

export async function getBulkEmailReport(params: ReportParams): Promise<LeadByteMessagingReportRow[]> {
  requireConfigured('get bulk email report');
  const res = await lbGet<unknown>('/reports/bulkemail', buildReportQuery(params));
  return unwrapReport<LeadByteMessagingReportRow & { campaign: unknown }>(res).map(normaliseMessagingRow);
}

export async function getBulkSmsReport(params: ReportParams): Promise<LeadByteMessagingReportRow[]> {
  requireConfigured('get bulk sms report');
  const res = await lbGet<unknown>('/reports/bulksms', buildReportQuery(params));
  return unwrapReport<LeadByteMessagingReportRow & { campaign: unknown }>(res).map(normaliseMessagingRow);
}

export async function getBuyerReport(params: ReportParams): Promise<LeadByteBuyerReportRow[]> {
  requireConfigured('get buyer report');
  const res = await lbGet<unknown>('/reports/buyer', buildReportQuery(params));
  return unwrapReport<LeadByteBuyerReportRow & { campaign: unknown; buyer: unknown }>(res).map(
    (r): LeadByteBuyerReportRow => ({
      ...r,
      campaign: flatRef(r.campaign),
      buyer: flatRef(r.buyer),
      currency: toIsoCurrency(r.currency as string | undefined),
    }),
  );
}

// ─── Credit ─────────────────────────────────────────────────────────────────

export async function addCredit(input: LeadByteCreditInput): Promise<unknown> {
  requireConfigured('add credit');
  return lbWrite('POST', '/credit/add', { key: apiKey(), ...input });
}

// ─── Buyers ─────────────────────────────────────────────────────────────────

export async function createBuyer(input: LeadByteBuyerCreateInput): Promise<unknown> {
  requireConfigured('create buyer');
  return lbWrite('POST', '/buyers/create', input);
}

export async function getBuyers(statusFilter?: 'Active' | 'Inactive'): Promise<LeadByteBuyer[]> {
  if (!isConfigured()) {
    logMock('getBuyers');
    return statusFilter ? MOCK_BUYERS.filter((b) => b.status === statusFilter) : MOCK_BUYERS;
  }
  return lbGet<LeadByteBuyer[]>('/buyers', { status: statusFilter });
}

export async function getBuyerById(id: string | number): Promise<LeadByteBuyer> {
  if (!isConfigured()) {
    logMock(`getBuyerById(${id})`);
    const hit = MOCK_BUYERS.find((b) => String(b.id) === String(id));
    return hit ?? MOCK_BUYERS[0];
  }
  return lbGet<LeadByteBuyer>(`/buyers/${id}`);
}

export async function updateBuyers(buyers: Array<{ id: string | number; update: LeadByteBuyerUpdate }>): Promise<unknown> {
  requireConfigured('update buyers');
  return lbWrite('PUT', '/buyers', { key: apiKey(), buyers });
}

export async function updateBuyerById(id: string | number, update: LeadByteBuyerUpdate): Promise<unknown> {
  requireConfigured('update buyer');
  return lbWrite('PUT', `/buyers/${id}`, { key: apiKey(), update });
}

// ─── Quarantine ─────────────────────────────────────────────────────────────

export async function processQuarantine(input: LeadByteQuarantineInput): Promise<unknown> {
  requireConfigured('process quarantine');
  return lbWrite('POST', '/quarantine/process', input);
}

// ─── Sync ───────────────────────────────────────────────────────────────────

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  campaignsFetched: number;
  campaignsUpdated: number;
  unmappedCampaignIds: string[];
  error?: string;
}

/**
 * Hourly sync job — refreshes our campaigns table with the latest name/status/vertical
 * from LeadByte. Only updates campaigns that already have `leadbyte_campaign_id` set;
 * unmapped LeadByte IDs are returned so Sam can populate the mapping in Settings.
 *
 * Invoked by the `sync` BullMQ worker when job name === 'leadbyte-hourly-sync'.
 */
export async function syncAll(deps: {
  db: typeof import('../../config/database.js').db;
  campaigns: typeof import('../../db/schema/campaigns.js').campaigns;
}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const result: SyncResult = {
    startedAt,
    finishedAt: startedAt,
    campaignsFetched: 0,
    campaignsUpdated: 0,
    unmappedCampaignIds: [],
  };

  if (!isConfigured()) {
    result.error = 'LeadByte not configured — skipping sync';
    result.finishedAt = new Date().toISOString();
    logger.warn(result.error);
    return result;
  }

  if (!deps.db) {
    result.error = 'Database not configured — skipping sync';
    result.finishedAt = new Date().toISOString();
    logger.warn(result.error);
    return result;
  }

  try {
    const lbCampaigns = await getCampaigns();
    result.campaignsFetched = lbCampaigns.length;

    const { eq } = await import('drizzle-orm');

    for (const c of lbCampaigns) {
      const updated = await deps.db
        .update(deps.campaigns)
        .set({
          name: c.name,
          vertical: c.vertical,
          status: c.status,
          updatedAt: new Date(),
        })
        .where(eq(deps.campaigns.leadbyteCampaignId, c.id))
        .returning({ id: deps.campaigns.id });

      if (updated.length > 0) {
        result.campaignsUpdated += updated.length;
      } else {
        result.unmappedCampaignIds.push(c.id);
      }
    }

    result.finishedAt = new Date().toISOString();
    logger.info(
      {
        fetched: result.campaignsFetched,
        updated: result.campaignsUpdated,
        unmapped: result.unmappedCampaignIds.length,
      },
      'LeadByte sync complete',
    );
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.finishedAt = new Date().toISOString();
    logger.error({ err }, 'LeadByte sync failed');
    return result;
  }
}
