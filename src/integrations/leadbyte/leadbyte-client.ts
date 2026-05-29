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
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
    signal: AbortSignal.timeout(5_000),
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
    signal: AbortSignal.timeout(5_000),
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
  if (!res || typeof res !== 'object') return [];
  const r = res as Record<string, unknown>;
  // Common shapes first (data, report).
  if (Array.isArray(r.data)) return r.data as T[];
  if (Array.isArray(r.report)) return r.report as T[];
  // /reports/leadactivity (and some other endpoints) wrap the rows under a
  // semantic key like "leads", "activity", or "rows" depending on
  // showData/groupBy. Pick the first array-shaped value that isn't a
  // metadata field — this keeps us robust against LeadByte tweaking shapes.
  const skipKeys = new Set(['status', 'message', 'benchmark', 'meta', 'pagination']);
  for (const [key, val] of Object.entries(r)) {
    if (skipKeys.has(key)) continue;
    if (Array.isArray(val)) return val as T[];
  }
  return [];
}

/**
 * LeadByte's list endpoints (e.g. /buyers, /deliveries, /responders) return
 * `{status: 'Success', message: 'OK', <pluralKey>: [...]}` rather than the
 * raw array — the upstream API wraps the list in an envelope.
 *
 * Pre-fix: callers blindly cast `lbGet<T[]>(...)`, so the typed return looked
 * right but was actually the envelope object. The dashboard /buyers + /deliveries
 * pages then tried to `.map()` over a non-array and hung "loading" forever.
 *
 * This helper extracts the list whether it lives under the named key, under
 * `data`, or is already a plain array (for paranoid robustness against future
 * shape changes).
 */
function unwrapList<T>(res: unknown, primaryKey: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    if (Array.isArray(obj[primaryKey])) return obj[primaryKey] as T[];
    if (Array.isArray(obj.data)) return obj.data as T[];
  }
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

// Strict no-fake-data policy: when LEADBYTE_API_KEY is not configured, every
// fallback returns an empty array. The UI then shows "No data available"
// instead of fabricated names and numbers.
const MOCK_CAMPAIGNS: LeadByteCampaign[] = [];
const MOCK_SUPPLIERS: LeadByteSupplier[] = [];

function generateMockDeliveries(_campaignId: string, _days: number): LeadByteDeliveryReport[] {
  return [];
}

// ─── Normalisers ────────────────────────────────────────────────────────────

function normaliseCampaign(raw: LeadByteCampaignRaw): LeadByteCampaign {
  // LeadByte returns active/archived as 'Yes'|'No' in docs but the live API
  // has been observed sending '1'|'0', booleans, or omitting the field entirely
  // when a campaign is live. Treat anything explicitly truthy as yes, anything
  // explicitly falsy as no, and default to active (live) when unset — campaigns
  // returned by /campaigns are running unless flagged otherwise.
  const isYes = (v: unknown): boolean =>
    v === 'Yes' || v === 'yes' || v === true || v === 1 || v === '1';
  const isNo = (v: unknown): boolean =>
    v === 'No' || v === 'no' || v === false || v === 0 || v === '0';
  const archived = isYes(raw.archived);
  let status: LeadByteCampaign['status'];
  if (archived) status = 'inactive';
  else if (isNo(raw.active)) status = 'paused';
  else status = 'active';
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
        // Mock has no invalid split — same as totals.
        validLeads: leads,
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
    // LeadByte returns supplier as a `{name, id}` ref or a flat string. For
    // direct/internal traffic (no supplier configured on the campaign) the
    // field comes back as an empty string. Label those rows "Direct" so the
    // UI shows a meaningful name instead of a blank cell, and stable-key
    // them so all "direct" rows for the same campaign aggregate together.
    const rawSupplierName = flatRef(r.supplier);
    const supplierName = rawSupplierName || 'Direct';
    const platform = rawSupplierName || 'Direct';
    const campaignName = flatRef(r.campaign);
    const supplierKey = rawSupplierName
      ? `lb-sup-${rawSupplierName}`
      : `lb-sup-direct-${refId(r.campaign) || campaignName || i}`;
    return {
      supplierId: supplierKey,
      supplierName,
      platform,
      campaignId: refId(r.campaign) || campaignName,
      campaignName,
      window,
      spend: r.payout,
      leads: r.leads,
      validLeads: r.valid,
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
    (r): LeadByteCampaignReportRow => {
      // Only emit campaignId when the raw ref was an object with an id —
      // refId() would otherwise return the string itself for flat-string
      // refs ("Solar Panels"), which is not a LeadByte numeric id.
      const rawCampaign = r.campaign;
      const campaignId =
        typeof rawCampaign === 'object' &&
        rawCampaign !== null &&
        'id' in rawCampaign &&
        (typeof (rawCampaign as { id: unknown }).id === 'string' ||
          typeof (rawCampaign as { id: unknown }).id === 'number')
          ? String((rawCampaign as { id: string | number }).id)
          : undefined;
      return {
        ...r,
        campaign: flatRef(rawCampaign),
        campaignId,
        currency: toIsoCurrency(r.currency as string | undefined),
      };
    },
  );
}

/**
 * Pro-rate windowed campaign totals (revenue + payout/cost) across daily
 * lead counts. LeadByte's `/reports/leadactivity` only returns per-day
 * COUNTS, while `/reports/campaign` returns aggregated REVENUE + PAYOUT
 * for the whole window. To get per-day money we spread the aggregate
 * proportionally by leadCount.
 *
 * Returns `{ revenue: 0, cost: 0 }` when totals.leads is zero (or NaN)
 * to avoid divide-by-zero — the day will still be written with its lead
 * count, just without money attribution.
 *
 * Exported for unit testing.
 */
export function proRateDailyMoney(args: {
  leadCount: number;
  totalLeads: number;
  totalRevenue: number;
  totalPayout: number;
}): { revenue: number; cost: number } {
  const { leadCount, totalLeads, totalRevenue, totalPayout } = args;
  if (!Number.isFinite(totalLeads) || totalLeads <= 0 || leadCount <= 0) {
    return { revenue: 0, cost: 0 };
  }
  const revPerLead = (Number.isFinite(totalRevenue) ? totalRevenue : 0) / totalLeads;
  const costPerLead = (Number.isFinite(totalPayout) ? totalPayout : 0) / totalLeads;
  return {
    revenue: Math.round(leadCount * revPerLead * 100) / 100,
    cost: Math.round(leadCount * costPerLead * 100) / 100,
  };
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

// All buyer/delivery/responder fallbacks return empty when API not configured.
// UI shows "No data available" placeholder.
const MOCK_BUYERS: LeadByteBuyer[] = [];
const MOCK_DELIVERIES: LeadByteDelivery[] = [];
const MOCK_RESPONDERS: LeadByteResponder[] = [];

function logMock(scope: string): void {
  logger.warn(`LeadByte ${scope} — returning mocks (LEADBYTE_API_KEY not configured)`);
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

export async function getCampaignById(id: string | number): Promise<LeadByteCampaignDetail> {
  if (!isConfigured()) {
    // No-fake-data policy: previously returned a named "Mock Campaign (for demo)"
    // object which could land in the UI looking like a real row. All other
    // LeadByte mocks return empty arrays/objects so unconfigured deploys
    // surface as obvious "no data" instead of fake content. Single-object
    // getters now return an empty-shape placeholder rather than a named fake.
    logMock(`getCampaignById(${id})`);
    return { id: String(id), name: '', reference: '', active: 'No', fields: [] };
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
  const res = await lbGet<unknown>('/deliveries', filter as Record<string, string | number | undefined>);
  return unwrapList<LeadByteDelivery>(res, 'deliveries');
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
  const res = await lbGet<unknown>('/responders');
  return unwrapList<LeadByteResponder>(res, 'responders');
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
  const res = await lbGet<unknown>('/buyers', { status: statusFilter });
  return unwrapList<LeadByteBuyer>(res, 'buyers');
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

// ─── Skipped-campaign observability ─────────────────────────────────────────
//
// `populateLeadDeliveries` skips campaigns mapped to more than one buyer
// because LeadByte's /reports/* endpoints don't expose per-buyer daily
// granularity — attributing the campaign-level daily totals to one of the
// linked clients would corrupt the dashboard. The skip is correct, but
// silent (just a log line) meant operators had no way to see which
// campaigns were affected from the UI. We keep the last 100 skip events
// in memory (FIFO) and expose them through the existing /leadbyte/status
// endpoint so the integrations page can render them. In-memory only:
// they reset on API restart, which is fine for an observability signal
// (a DB table would be overkill for a list that's recomputed every hour).
export interface SkippedCampaign {
  campaignId: string;
  campaignName: string | null;
  buyerCount: number;
  at: string; // ISO timestamp
}

const SKIPPED_CAMPAIGNS_MAX = 100;
const skippedCampaigns: SkippedCampaign[] = [];

export function recordSkippedCampaign(entry: SkippedCampaign): void {
  skippedCampaigns.push(entry);
  while (skippedCampaigns.length > SKIPPED_CAMPAIGNS_MAX) {
    skippedCampaigns.shift();
  }
}

/** Returns a copy (newest first) so callers can't mutate the internal buffer. */
export function getSkippedCampaigns(): SkippedCampaign[] {
  return [...skippedCampaigns].reverse();
}

/** Test-only — drops every entry. */
export function __resetSkippedCampaigns(): void {
  skippedCampaigns.length = 0;
}

// ─── Sync ───────────────────────────────────────────────────────────────────

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  campaignsFetched: number;
  campaignsUpdated: number;
  campaignsCreated: number;
  campaignLinksCreated: number;
  deliveriesUpserted: number;
  deliveryCampaignsSkipped: number;
  unmappedCampaignIds: string[];
  error?: string;
}

/**
 * Hourly sync job — refreshes our campaigns table with the latest name/status/vertical
 * from LeadByte. Updates existing rows by `leadbyte_campaign_id`, and auto-creates
 * a Sato-side row for any LeadByte campaign that doesn't have a local row yet —
 * this is the FK target that `client_campaigns` and `lead_deliveries` reference,
 * so without it those dashboards stay empty.
 *
 * Piece 2: also auto-links Sato clients (clients.leadbyte_client_id) to
 * campaigns via the client_campaigns join table when LeadByte's buyer report
 * shows a buyer on a campaign whose name matches a Sato client's. Conservative
 * — only links when the LeadByte buyer id maps to exactly one Sato client and
 * the name matches case-insensitively; ON CONFLICT DO NOTHING via the
 * (client_id, campaign_id) unique index, so re-runs are idempotent.
 *
 * Invoked by the `sync` BullMQ worker when job name === 'leadbyte-hourly-sync'.
 */
export async function syncAll(deps: {
  db: typeof import('../../config/database.js').db;
  campaigns: typeof import('../../db/schema/campaigns.js').campaigns;
  clients?: typeof import('../../db/schema/clients.js').clients;
  clientCampaigns?: typeof import('../../db/schema/client-campaigns.js').clientCampaigns;
  leadDeliveries?: typeof import('../../db/schema/lead-deliveries.js').leadDeliveries;
}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const result: SyncResult = {
    startedAt,
    finishedAt: startedAt,
    campaignsFetched: 0,
    campaignsUpdated: 0,
    campaignsCreated: 0,
    campaignLinksCreated: 0,
    deliveriesUpserted: 0,
    deliveryCampaignsSkipped: 0,
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
        continue;
      }

      // Piece 1: no local row yet — auto-create one so this LeadByte campaign
      // becomes a valid FK target for client_campaigns / lead_deliveries.
      // Sato-side overrides (cost_per_lead, campaign_type) start at schema
      // defaults; staff can edit them later from the campaign detail page.
      const inserted = await deps.db
        .insert(deps.campaigns)
        .values({
          leadbyteCampaignId: c.id,
          name: c.name,
          vertical: c.vertical || null,
          status: c.status,
          currency: c.currency,
        })
        .returning({ id: deps.campaigns.id });

      if (inserted.length > 0) {
        result.campaignsCreated += inserted.length;
      } else {
        result.unmappedCampaignIds.push(c.id);
      }
    }

    // Piece 2: auto-link clients ↔ campaigns via client_campaigns. Skipped
    // when the caller didn't pass the schemas (existing callers/tests stay
    // happy) or when there are no Sato clients mapped to a LeadByte buyer id.
    if (deps.clients && deps.clientCampaigns) {
      try {
        result.campaignLinksCreated = await discoverClientCampaignLinks({
          db: deps.db,
          campaigns: deps.campaigns,
          clients: deps.clients,
          clientCampaigns: deps.clientCampaigns,
        });
      } catch (err) {
        // Discovery failures don't fail the sync — the campaign UPDATE/INSERT
        // pass above is the primary value; auto-linking is a nice-to-have.
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LeadByte client_campaigns discovery failed');
      }
    }

    // Piece 3: write per-day lead_deliveries rows for each linked
    // (client × campaign) pair so the dashboard leads-by-day chart, KPI
    // tiles, and auto-invoice cron have real data to read. Skipped when
    // schemas are missing (legacy callers) or there are no links yet.
    if (deps.clientCampaigns && deps.leadDeliveries) {
      try {
        const dr = await populateLeadDeliveries({
          db: deps.db,
          campaigns: deps.campaigns,
          clientCampaigns: deps.clientCampaigns,
          leadDeliveries: deps.leadDeliveries,
        });
        result.deliveriesUpserted = dr.rowsUpserted;
        result.deliveryCampaignsSkipped = dr.campaignsSkipped;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LeadByte lead_deliveries write failed');
      }
    }

    result.finishedAt = new Date().toISOString();
    logger.info(
      {
        fetched: result.campaignsFetched,
        updated: result.campaignsUpdated,
        created: result.campaignsCreated,
        linksCreated: result.campaignLinksCreated,
        deliveriesUpserted: result.deliveriesUpserted,
        deliverySkipped: result.deliveryCampaignsSkipped,
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

/**
 * Normalise a LeadByte buyer/company name for cross-endpoint matching.
 * `/buyers` and `/reports/buyer` aren't perfectly consistent — Benson
 * Goldstein appeared as "Benson Goldstein Ltd" in one and "Benson Goldstein"
 * in the other, silently breaking the auto-link in `discoverClientCampaignLinks`.
 * Strips legal-entity suffixes + punctuation + collapses whitespace so the
 * same buyer compares equal across endpoints.
 */
export function normalizeBuyerName(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase();
  // Strip punctuation that varies between endpoints.
  s = s.replace(/[.,()]/g, ' ');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Strip a single trailing legal-entity suffix. Order matters: longer
  // tokens first so "limited" isn't eaten by "ltd"'s prefix check.
  s = s.replace(/\s+(corporation|limited|llc|plc|ltd|inc|corp|co)$/u, '');
  return s.trim();
}

/**
 * Auto-link Sato clients to LeadByte campaigns via client_campaigns. For each
 * local campaign that has NO existing links, fetch LeadByte's /reports/buyer
 * for that campaign, match the buyer name to a LeadByte buyer id, then map
 * that to a Sato client via clients.leadbyte_client_id. Inserts are
 * idempotent thanks to the (client_id, campaign_id) unique index.
 *
 * Returns the count of NEW client_campaigns rows created.
 */
async function discoverClientCampaignLinks(deps: {
  db: typeof import('../../config/database.js').db;
  campaigns: typeof import('../../db/schema/campaigns.js').campaigns;
  clients: typeof import('../../db/schema/clients.js').clients;
  clientCampaigns: typeof import('../../db/schema/client-campaigns.js').clientCampaigns;
}): Promise<number> {
  const { isNotNull } = await import('drizzle-orm');

  // 1) Load Sato clients that have a LeadByte buyer id. If none, nothing to link.
  const satoClientsRaw = await deps.db
    .select({
      id: deps.clients.id,
      companyName: deps.clients.companyName,
      leadbyteClientId: deps.clients.leadbyteClientId,
    })
    .from(deps.clients)
    .where(isNotNull(deps.clients.leadbyteClientId));
  if (satoClientsRaw.length === 0) return 0;

  const byLeadbyteBuyerId = new Map<string, { id: string; companyName: string }>();
  for (const c of satoClientsRaw) {
    if (c.leadbyteClientId) {
      byLeadbyteBuyerId.set(String(c.leadbyteClientId), { id: c.id, companyName: c.companyName });
    }
  }

  // 2) Find campaigns that could need linking: any campaign with a
  // leadbyte_campaign_id. The previous filter excluded campaigns that
  // already had ANY client_campaigns row — which silently broke
  // multi-buyer campaigns. Once UKESN was linked to INSULATION, Benson
  // Goldstein (who also buys INSULATION leads) could never auto-link
  // because INSULATION was no longer a "candidate". The (client_id,
  // campaign_id) unique index + ON CONFLICT DO NOTHING below makes
  // re-checking already-linked campaigns safe — no duplicates inserted,
  // just an extra buyer-report fetch per hourly run, which is fine.
  const candidates = await deps.db
    .select({
      campaignId: deps.campaigns.id,
      leadbyteCampaignId: deps.campaigns.leadbyteCampaignId,
    })
    .from(deps.campaigns)
    .where(isNotNull(deps.campaigns.leadbyteCampaignId));
  if (candidates.length === 0) return 0;

  // 3) Load buyers once: normalised name → leadbyte buyer id. Used to
  // resolve the buyer name returned by /reports/buyer back to a buyer id we
  // can match against clients.leadbyte_client_id. Normalisation handles the
  // suffix/punctuation drift between /buyers and /reports/buyer (see
  // `normalizeBuyerName` — Benson Goldstein regression, 2026-05-17).
  const buyers = await getBuyers();
  const nameToBuyerId = new Map<string, string>();
  for (const b of buyers) {
    if (b.company && b.id != null) {
      nameToBuyerId.set(normalizeBuyerName(b.company), String(b.id));
    }
  }

  // 4) Per-campaign buyer-report discovery. ytd window so we catch any
  // historical buyer even if last_month is empty. Each call is independent —
  // a per-campaign failure logs + continues.
  //
  // unresolvedBuyerNames tracks normalised buyer names that showed up in
  // /reports/buyer but didn't match any /buyers entry — useful debug signal
  // when a future client should auto-link but isn't.
  let created = 0;
  const unresolvedBuyerNames = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.leadbyteCampaignId) continue;
    let report: LeadByteBuyerReportRow[];
    try {
      report = await getBuyerReport({
        campaignId: candidate.leadbyteCampaignId,
        window: 'ytd',
      });
    } catch (err) {
      logger.warn(
        { campaignId: candidate.leadbyteCampaignId, err: err instanceof Error ? err.message : String(err) },
        'LeadByte buyer-report fetch failed during discovery — skipping campaign',
      );
      continue;
    }

    const buyerNames = new Set<string>();
    for (const row of report) {
      if (row.buyer) buyerNames.add(normalizeBuyerName(row.buyer));
    }

    for (const buyerName of buyerNames) {
      const buyerId = nameToBuyerId.get(buyerName);
      if (!buyerId) {
        unresolvedBuyerNames.add(buyerName);
        continue;
      }
      const satoClient = byLeadbyteBuyerId.get(buyerId);
      if (!satoClient) continue;

      // ON CONFLICT DO NOTHING via the (client_id, campaign_id) unique index.
      const inserted = await deps.db
        .insert(deps.clientCampaigns)
        .values({
          clientId: satoClient.id,
          campaignId: candidate.campaignId,
        })
        .onConflictDoNothing()
        .returning({ id: deps.clientCampaigns.id });
      if (inserted.length > 0) {
        created++;
        logger.info(
          {
            clientId: satoClient.id,
            clientName: satoClient.companyName,
            campaignId: candidate.campaignId,
            leadbyteCampaignId: candidate.leadbyteCampaignId,
          },
          'LeadByte auto-linked client ↔ campaign',
        );
      }
    }
  }

  if (unresolvedBuyerNames.size > 0) {
    logger.warn(
      { unresolvedBuyerNames: Array.from(unresolvedBuyerNames) },
      'LeadByte buyer names from /reports/buyer that did not match any /buyers entry — check for name drift or missing buyers',
    );
  }

  return created;
}

/**
 * Piece 3: write daily lead_deliveries rows for each linked (client, campaign)
 * pair.
 *
 * LeadByte's /reports/leadactivity returns daily lead counts per CAMPAIGN
 * (not per-buyer). To safely attribute counts to a specific client, we only
 * write for campaigns with exactly ONE linked client — those daily totals
 * unambiguously belong to that client. Multi-client campaigns are skipped
 * with a log line (we don't have per-buyer daily granularity from the API
 * yet; misattribution would corrupt the dashboard).
 *
 * Idempotent via the (campaign_id, client_id, delivery_date) unique index
 * — re-runs UPDATE the same rows so the table converges to the latest
 * LeadByte numbers each cycle.
 */
async function populateLeadDeliveries(deps: {
  db: typeof import('../../config/database.js').db;
  campaigns: typeof import('../../db/schema/campaigns.js').campaigns;
  clientCampaigns: typeof import('../../db/schema/client-campaigns.js').clientCampaigns;
  leadDeliveries: typeof import('../../db/schema/lead-deliveries.js').leadDeliveries;
}): Promise<{ rowsUpserted: number; campaignsSkipped: number }> {
  const { eq, isNotNull } = await import('drizzle-orm');

  // Group links by campaign: campaign_id → list of client_ids.
  // Also pull the campaign name so skip-event records carry a human label
  // (the integrations page surfaces these — leadbyteCampaignId alone is
  // meaningless to operators).
  const links = await deps.db
    .select({
      campaignId: deps.clientCampaigns.campaignId,
      clientId: deps.clientCampaigns.clientId,
      leadbyteCampaignId: deps.campaigns.leadbyteCampaignId,
      campaignName: deps.campaigns.name,
    })
    .from(deps.clientCampaigns)
    .innerJoin(deps.campaigns, eq(deps.campaigns.id, deps.clientCampaigns.campaignId))
    .where(isNotNull(deps.campaigns.leadbyteCampaignId));
  if (links.length === 0) return { rowsUpserted: 0, campaignsSkipped: 0 };

  const byCampaign = new Map<string, { campaignId: string; leadbyteCampaignId: string; campaignName: string | null; clientIds: string[] }>();
  for (const l of links) {
    const lbId = l.leadbyteCampaignId;
    if (!lbId) continue;
    const entry = byCampaign.get(l.campaignId) ?? {
      campaignId: l.campaignId,
      leadbyteCampaignId: lbId,
      campaignName: l.campaignName ?? null,
      clientIds: [],
    };
    entry.clientIds.push(l.clientId);
    byCampaign.set(l.campaignId, entry);
  }

  // Fetch campaign totals (revenue + payout) per window ONCE for all campaigns.
  // /reports/leadactivity gives daily lead counts but no money; /reports/campaign
  // gives windowed money totals. We pro-rate the windowed money by daily lead
  // count below. If a window fetch fails (or returns no row for the campaign)
  // the per-row writer below omits the money fields entirely so existing
  // revenue/cost values are preserved — a transient upstream failure must NOT
  // overwrite previously computed money with zeros.
  type CampaignTotals = { revenue: number; payout: number; leads: number };
  const buildTotalsMap = (rows: LeadByteCampaignReportRow[]): Map<string, CampaignTotals> => {
    const m = new Map<string, CampaignTotals>();
    for (const r of rows) {
      if (!r.campaignId) continue;
      m.set(r.campaignId, { revenue: r.revenue ?? 0, payout: r.payout ?? 0, leads: r.leads ?? 0 });
    }
    return m;
  };
  const fetchReport = async (window: 'last_month' | 'this_month'): Promise<LeadByteCampaignReportRow[]> => {
    try {
      return await getCampaignReport(window);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), window },
        'lead_deliveries: getCampaignReport failed — money fields will be left untouched for rows in this window',
      );
      return [];
    }
  };
  const [lastMonthReport, thisMonthReport] = await Promise.all([
    fetchReport('last_month'),
    fetchReport('this_month'),
  ]);
  const lastMonthTotals = buildTotalsMap(lastMonthReport);
  const thisMonthTotals = buildTotalsMap(thisMonthReport);

  let rowsUpserted = 0;
  let campaignsSkipped = 0;

  for (const entry of byCampaign.values()) {
    if (entry.clientIds.length !== 1) {
      // Multi-client campaign: API only returns campaign-level daily totals,
      // can't safely attribute. Skip + log + record into the in-memory skip
      // buffer so the integrations page can surface affected campaigns
      // without trawling Railway logs. Future enhancement: per-buyer
      // groupBy on /reports/* if LeadByte supports it.
      campaignsSkipped++;
      logger.warn(
        {
          campaignId: entry.campaignId,
          leadbyteCampaignId: entry.leadbyteCampaignId,
          linkedClientCount: entry.clientIds.length,
        },
        'lead_deliveries: skipping multi-client campaign — no per-buyer daily attribution yet',
      );
      recordSkippedCampaign({
        campaignId: entry.leadbyteCampaignId,
        campaignName: entry.campaignName,
        buyerCount: entry.clientIds.length,
        at: new Date().toISOString(),
      });
      continue;
    }

    const clientId = entry.clientIds[0];
    type DailyRowWithWindow = LeadByteDeliveryReport & { window: 'last_month' | 'this_month' };
    let dailyRows: DailyRowWithWindow[];
    try {
      // /reports/leadactivity silently returns 0 rows when fed an arbitrary
      // from/to range (the number-of-days overload); only named windows
      // actually pull data. Pull last_month + this_month so we cover the
      // dashboard's "leads this month" + "leads last month" KPIs in full.
      // Idempotent upsert below dedupes overlap. Tag each row with its
      // source window so we pick the right totals map for pro-ration.
      const [lastMonth, thisMonth] = await Promise.all([
        getDeliveryReports(entry.leadbyteCampaignId, 'last_month'),
        getDeliveryReports(entry.leadbyteCampaignId, 'this_month'),
      ]);
      dailyRows = [
        ...lastMonth.map((r): DailyRowWithWindow => ({ ...r, window: 'last_month' })),
        ...thisMonth.map((r): DailyRowWithWindow => ({ ...r, window: 'this_month' })),
      ];
    } catch (err) {
      logger.warn(
        { campaignId: entry.campaignId, err: err instanceof Error ? err.message : String(err) },
        'lead_deliveries: getDeliveryReports failed — skipping campaign',
      );
      continue;
    }

    // Per-window leadCount totals from the daily activity report. We pro-rate
    // money against *these* (the same source that produces our daily rows)
    // rather than the /reports/campaign `leads` field — the two can drift
    // for invalid/rejected splits and we want £ to add up to the windowed
    // total when summed across days.
    const dailyLeadSumByWindow: Record<'last_month' | 'this_month', number> = {
      last_month: dailyRows
        .filter((r) => r.window === 'last_month')
        .reduce((s, r) => s + (r.leadCount ?? 0), 0),
      this_month: dailyRows
        .filter((r) => r.window === 'this_month')
        .reduce((s, r) => s + (r.leadCount ?? 0), 0),
    };

    for (const row of dailyRows) {
      if (!row.date || row.leadCount <= 0) continue;
      const windowTotals =
        row.window === 'last_month'
          ? lastMonthTotals.get(entry.leadbyteCampaignId)
          : thisMonthTotals.get(entry.leadbyteCampaignId);
      const dailyLeadSum = dailyLeadSumByWindow[row.window];
      // Only attribute money when we have a campaign-report row AND a
      // positive daily-leads denominator. Otherwise omit revenue/cost from
      // the upsert entirely so a transient /reports/campaign failure or
      // an unmapped-campaign cache result cannot overwrite previously
      // computed values with zeros.
      const moneyAvailable = !!windowTotals && dailyLeadSum > 0;
      const { revenue, cost } = moneyAvailable
        ? proRateDailyMoney({
            leadCount: row.leadCount,
            totalLeads: dailyLeadSum,
            totalRevenue: windowTotals!.revenue,
            totalPayout: windowTotals!.payout,
          })
        : { revenue: 0, cost: 0 };
      const moneyValues = moneyAvailable
        ? { revenue: revenue.toFixed(2), cost: cost.toFixed(2) }
        : {};

      const upserted = await deps.db
        .insert(deps.leadDeliveries)
        .values({
          campaignId: entry.campaignId,
          clientId,
          deliveryDate: row.date,
          leadCount: row.leadCount,
          validLeadCount: row.validLeads,
          invalidLeadCount: row.invalidLeads,
          ...moneyValues,
          leadbyteReportId: row.reportId,
          source: 'leadbyte',
        })
        .onConflictDoUpdate({
          target: [deps.leadDeliveries.campaignId, deps.leadDeliveries.clientId, deps.leadDeliveries.deliveryDate],
          set: {
            leadCount: row.leadCount,
            validLeadCount: row.validLeads,
            invalidLeadCount: row.invalidLeads,
            ...moneyValues,
            leadbyteReportId: row.reportId,
          },
        })
        .returning({ id: deps.leadDeliveries.id });
      if (upserted.length > 0) rowsUpserted++;
    }
  }

  return { rowsUpserted, campaignsSkipped };
}
