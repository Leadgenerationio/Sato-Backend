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

// ─── Sync ───────────────────────────────────────────────────────────────────

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  campaignsFetched: number;
  campaignsUpdated: number;
  campaignsCreated: number;
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
    campaignsCreated: 0,
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

    result.finishedAt = new Date().toISOString();
    logger.info(
      {
        fetched: result.campaignsFetched,
        updated: result.campaignsUpdated,
        created: result.campaignsCreated,
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
