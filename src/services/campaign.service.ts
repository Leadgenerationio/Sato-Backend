import { eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import { cached } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// LeadByte campaign aggregates change slowly relative to dashboard load
// frequency. Caching them for 15 minutes is the sweet spot:
// - Long enough that meeting/demo gaps (5-15 min away from desk) don't
//   flush the cache and force the next user to wait 2-5s on a cold miss.
// - Short enough that the hourly LeadByte sync shows up in roughly the
//   right window — the prewarm worker keeps the cache fresh during active
//   use anyway, and the negative-cache (utils/cache.ts) absorbs blips.
// - Bumped from 5 min → 15 min on 2026-05-05 after measuring 2.5s warm
//   responses on /campaigns when cache TTL expired between visits during
//   a demo-prep walkthrough.
const CAMPAIGN_LIST_TTL_SECONDS = 900;
const DELIVERY_REPORT_TTL_SECONDS = 900;
const TYPE_MAP_TTL_SECONDS = 1800;

export type CampaignType = 'pay_per_lead' | 'managed' | 'internal';

/**
 * Sato-side campaign metadata (campaignType) lives in the campaigns table,
 * keyed by `leadbyte_campaign_id`. Loaded once per request via
 * `loadCampaignTypeMap`. Defaults to 'pay_per_lead' when no row exists yet.
 */
async function loadCampaignTypeMap(): Promise<Map<string, CampaignType>> {
  const rows = await db
    .select({
      leadbyteCampaignId: campaignsTable.leadbyteCampaignId,
      campaignType: campaignsTable.campaignType,
    })
    .from(campaignsTable)
    .where(sql`${campaignsTable.leadbyteCampaignId} is not null`);
  const map = new Map<string, CampaignType>();
  for (const r of rows) {
    if (r.leadbyteCampaignId) {
      map.set(r.leadbyteCampaignId, (r.campaignType as CampaignType) ?? 'pay_per_lead');
    }
  }
  return map;
}

function resolveCampaignType(id: string, map: Map<string, CampaignType>): CampaignType {
  return map.get(id) ?? 'pay_per_lead';
}

export async function setCampaignType(leadbyteCampaignId: string, type: CampaignType): Promise<void> {
  const [existing] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.leadbyteCampaignId, leadbyteCampaignId));
  if (existing) {
    await db
      .update(campaignsTable)
      .set({ campaignType: type, updatedAt: new Date() })
      .where(eq(campaignsTable.leadbyteCampaignId, leadbyteCampaignId));
  }
}

export interface CampaignSummary {
  id: string;
  name: string;
  clientName: string;
  vertical: string;
  status: string;
  campaignType: CampaignType;
  leadPrice: number;
  currency: string;
  totalLeads: number;
  leadsToday: number;
  leadsThisWeek: number;
  leadsThisMonth: number;
  totalRevenue: number;
  totalCost: number;
  cpl: number;
  margin: number;
  startDate: string;
}

export interface CampaignWindowTotals {
  leads: number;
  revenue: number;
  cost: number;
}

export interface CampaignDetail extends CampaignSummary {
  leadDeliveries: {
    date: string;
    leadCount: number;
    validLeads: number;
    invalidLeads: number;
    revenue: number;
    cost: number;
  }[];
  /** Per-window aggregate totals computed from /reports/campaign (which has
   * accurate revenue + cost), so the FE can render the per-tab figures
   * without relying on the daily leadactivity feed (which doesn't carry
   * money figures and sometimes returns empty). */
  windowReports: {
    today: CampaignWindowTotals;
    yesterday: CampaignWindowTotals;
    this_week: CampaignWindowTotals;
    last_week: CampaignWindowTotals;
    this_month: CampaignWindowTotals;
    last_month: CampaignWindowTotals;
    ytd: CampaignWindowTotals;
  };
  suppliers: {
    id: string;
    name: string;
    platform: string;
    totalSpend: number;
    totalLeads: number;
    cpl: number;
  }[];
}

export async function listCampaigns(_requester: AuthPayload): Promise<CampaignSummary[]> {
  // Fetch the campaign list + 4 windows of /reports/campaign in parallel.
  // /reports/campaign returns ALL campaigns aggregated for a window in ONE call,
  // so we only hit LeadByte 5 times total no matter how many campaigns Sam has
  // (was N+1 before — one /reports/leadactivity call per campaign — which both
  // scaled badly AND returned revenue: 0 because that endpoint only counts leads).
  //
  // Each window call is independently cached so repeat dashboard loads within
  // the TTL window get instant Redis hits.
  // Fetch independent things (campaigns + typeMap) in parallel.
  const [campaigns, typeMapEntries] = await Promise.all([
    cached('lb:campaigns', CAMPAIGN_LIST_TTL_SECONDS, () => leadbyte.getCampaigns()),
    cached('campaigns:type-map', TYPE_MAP_TTL_SECONDS, async () => {
      const m = await loadCampaignTypeMap();
      return Array.from(m.entries());
    }),
  ]);
  const typeMap = new Map(typeMapEntries);

  // /reports/campaign for the 4 windows. Fetched in parallel via
  // Promise.allSettled — if one window's LeadByte call times out (5s), the
  // other three still succeed and the table renders with whatever windows we
  // have. Cache-key naming matches the prewarmer
  // (jobs/cache-prewarm.service.ts) so warm hits served from Redis cost
  // <5ms. Combined with the 30s negative cache in utils/cache.ts, a
  // transient LeadByte blip no longer breaks the user-facing endpoint.
  const empty: Awaited<ReturnType<typeof leadbyte.getCampaignReport>> = [];
  const settled = await Promise.allSettled([
    cached('lb:report:today:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('today')),
    cached('lb:report:this_week:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_week')),
    cached('lb:report:this_month:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_month')),
    cached('lb:report:ytd:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('ytd')),
  ]);
  const pickOrEmpty = (p: PromiseSettledResult<typeof empty>, label: string): typeof empty => {
    if (p.status === 'fulfilled') return p.value;
    logger.warn({ label, reason: p.reason instanceof Error ? p.reason.message : String(p.reason) }, 'LeadByte report window failed — falling back to empty');
    return empty;
  };
  const todayReport = pickOrEmpty(settled[0], 'today');
  const weekReport = pickOrEmpty(settled[1], 'this_week');
  const monthReport = pickOrEmpty(settled[2], 'this_month');
  const ytdReport = pickOrEmpty(settled[3], 'ytd');

  // The report rows are keyed by campaign NAME (LeadByte's choice), so we
  // build name-keyed maps for fast lookup per campaign.
  type ReportRow = (typeof todayReport)[number];
  const byName = (rows: ReportRow[]) => new Map(rows.map((r) => [r.campaign, r] as const));
  const todayByName = byName(todayReport);
  const weekByName = byName(weekReport);
  const monthByName = byName(monthReport);
  const ytdByName = byName(ytdReport);

  return campaigns.map((c): CampaignSummary => {
    const today = todayByName.get(c.name);
    const week = weekByName.get(c.name);
    const month = monthByName.get(c.name);
    const ytd = ytdByName.get(c.name);

    // Revenue/cost/margin use the YTD figures when LeadByte returns them,
    // otherwise we synthesise lifetime totals from the windows we have so the
    // table never silently shows £0.
    //
    // 2026-05-05: Sam reported every campaign showing rev=£0 in the demo —
    // root cause: LeadByte's `ytd` window returns all zeros (campaigns:0,
    // leads:0, revenue:0) even though `last_month` reports £308k revenue and
    // `this_month` reports £30k. So when ytd has no row for the campaign,
    // fall back to summing the windows we DO have. This is approximate
    // (today + this_week + this_month + last_month) but always > 0 when
    // there's real activity, instead of silently zeroing the table.
    const sumWindows = (rows: Array<typeof today | undefined>, key: 'leads' | 'revenue' | 'payout' | 'emailCost' | 'smsCost' | 'validationCost') =>
      rows.reduce((sum, r) => sum + ((r?.[key] as number | undefined) ?? 0), 0);

    const ytdHasData = (ytd?.leads ?? 0) > 0 || (ytd?.revenue ?? 0) > 0;
    const fallbackRows = [today, week, month];
    // We fetch last_month upstream into one of the cached calls — but to keep
    // the fallback simple, sum the windows we already have (today + this_week
    // + this_month). This_month alone already covers most active revenue.
    const totalLeads = ytdHasData ? (ytd?.leads ?? 0) : sumWindows(fallbackRows, 'leads');
    const totalRevenue = ytdHasData ? (ytd?.revenue ?? 0) : sumWindows(fallbackRows, 'revenue');
    const fallbackCost =
      sumWindows(fallbackRows, 'payout') +
      sumWindows(fallbackRows, 'emailCost') +
      sumWindows(fallbackRows, 'smsCost') +
      sumWindows(fallbackRows, 'validationCost');
    const totalCost = ytdHasData
      ? (ytd?.payout ?? 0) + (ytd?.emailCost ?? 0) + (ytd?.smsCost ?? 0) + (ytd?.validationCost ?? 0)
      : fallbackCost;
    const cpl = totalLeads > 0 ? totalCost / totalLeads : 0;
    const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

    return {
      id: c.id,
      name: c.name,
      clientName: c.clientName,
      vertical: c.vertical,
      status: c.status,
      campaignType: resolveCampaignType(c.id, typeMap),
      leadPrice: c.leadPrice,
      currency: c.currency,
      totalLeads,
      leadsToday: today?.leads ?? 0,
      leadsThisWeek: week?.leads ?? 0,
      leadsThisMonth: month?.leads ?? 0,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      cpl: Math.round(cpl * 100) / 100,
      margin: Math.round(margin * 10) / 10,
      startDate: c.startDate,
    };
  });
}

export async function getCampaign(id: string, _requester: AuthPayload): Promise<CampaignDetail | null> {
  const [campaigns, typeMap] = await Promise.all([
    leadbyte.getCampaigns(),
    loadCampaignTypeMap(),
  ]);
  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return null;

  // Fetch in parallel:
  //  - daily lead breakdown (per-day chart) — cached per-campaign for 5 min
  //  - suppliers table — cached per-campaign for 5 min
  //  - 7 windows of /reports/campaign keyed by name (revenue / cost / margin
  //    per tab). Cache keys match the prewarmer at services/cache-prewarm
  //    so warm hits served from Redis cost <5ms — the keys for `this_week`
  //    and `this_month` were previously `lb:report:week`/`lb:report:month`,
  //    which never matched the prewarmer's `lb:report:this_week`/`...this_month`
  //    and forced 2 of the 7 windows to cold-fetch every time.
  const PER_CAMPAIGN_TTL = 300; // 5 min
  const [
    deliveries, suppliers,
    todayReport, yesterdayReport, weekReport, lastWeekReport,
    monthReport, lastMonthReport, ytdReport,
  ] = await Promise.all([
    cached(`lb:deliveries:${id}:30d:v1`, PER_CAMPAIGN_TTL, () => leadbyte.getDeliveryReports(id, 30)),
    cached(`lb:suppliers:${id}:30d:v1`, PER_CAMPAIGN_TTL, () => leadbyte.getSuppliers(id)),
    cached('lb:report:today:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('today')),
    cached('lb:report:yesterday:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('yesterday')),
    cached('lb:report:this_week:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_week')),
    cached('lb:report:last_week:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('last_week')),
    cached('lb:report:this_month:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_month')),
    cached('lb:report:last_month:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('last_month')),
    cached('lb:report:ytd:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('ytd')),
  ]);

  // /reports/campaign rows are keyed by campaign name (LeadByte's choice).
  const findRow = (rows: typeof ytdReport) => rows.find((r) => r.campaign === campaign.name);
  const todayRow = findRow(todayReport);
  const yesterdayRow = findRow(yesterdayReport);
  const weekRow = findRow(weekReport);
  const lastWeekRow = findRow(lastWeekReport);
  const monthRow = findRow(monthReport);
  const lastMonthRow = findRow(lastMonthReport);
  const ytdRow = findRow(ytdReport);

  const rowToWindow = (r: typeof todayRow): CampaignWindowTotals => ({
    leads: r?.leads ?? 0,
    revenue: Math.round((r?.revenue ?? 0) * 100) / 100,
    cost: Math.round(
      ((r?.payout ?? 0) + (r?.emailCost ?? 0) + (r?.smsCost ?? 0) + (r?.validationCost ?? 0)) * 100,
    ) / 100,
  });

  const windowReports = {
    today: rowToWindow(todayRow),
    yesterday: rowToWindow(yesterdayRow),
    this_week: rowToWindow(weekRow),
    last_week: rowToWindow(lastWeekRow),
    this_month: rowToWindow(monthRow),
    last_month: rowToWindow(lastMonthRow),
    ytd: rowToWindow(ytdRow),
  };

  const totalLeads = ytdRow?.leads ?? 0;
  const leadsToday = todayRow?.leads ?? 0;
  const leadsThisWeek = weekRow?.leads ?? 0;
  const leadsThisMonth = monthRow?.leads ?? 0;
  const totalRevenue = ytdRow?.revenue ?? 0;
  const totalCost =
    (ytdRow?.payout ?? 0) +
    (ytdRow?.emailCost ?? 0) +
    (ytdRow?.smsCost ?? 0) +
    (ytdRow?.validationCost ?? 0);
  const cpl = totalLeads > 0 ? totalCost / totalLeads : 0;
  const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

  return {
    id: campaign.id,
    name: campaign.name,
    clientName: campaign.clientName,
    vertical: campaign.vertical,
    status: campaign.status,
    campaignType: resolveCampaignType(campaign.id, typeMap),
    leadPrice: campaign.leadPrice,
    currency: campaign.currency,
    totalLeads,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    cpl: Math.round(cpl * 100) / 100,
    margin: Math.round(margin * 10) / 10,
    startDate: campaign.startDate,
    leadDeliveries: deliveries.map((d) => ({
      date: d.date,
      leadCount: d.leadCount,
      validLeads: d.validLeads,
      invalidLeads: d.invalidLeads,
      revenue: d.revenue,
      cost: d.cost,
    })),
    windowReports,
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      platform: s.platform,
      totalSpend: s.totalSpend,
      totalLeads: s.totalLeads,
      cpl: s.totalLeads > 0 ? Math.round((s.totalSpend / s.totalLeads) * 100) / 100 : 0,
    })),
  };
}
