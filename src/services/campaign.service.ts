import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clients } from '../db/schema/clients.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import { cached } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { pickVertical } from '../utils/vertical.js';
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

/**
 * Update editable Sato-side campaign fields. Sam's #41: cost_per_lead is
 * surface-edited from the campaign detail page; this is the write path.
 *
 * Accepts either a Sato UUID or a LeadByte campaign id — vertical-only
 * campaigns (no LeadByte counterpart) use the UUID, while legacy LeadByte-
 * synced campaigns are addressed by their LeadByte id in the URL.
 *
 * Auto-creates a Sato row when the LeadByte campaign doesn't have one yet —
 * keeps the user from having to "save" a campaign before they can set its
 * cost, since the LeadByte sync is the primary source for everything else.
 */
export interface UpdateCampaignInput {
  costPerLead?: number | null;
}

export async function updateCampaign(
  id: string,
  input: UpdateCampaignInput,
  _requester: AuthPayload,
): Promise<{ id: string; costPerLead: number | null } | null> {
  // Try as Sato UUID first.
  let [row] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id));

  // Not a UUID match — treat as LeadByte id.
  if (!row) {
    [row] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.leadbyteCampaignId, id));
  }

  // No Sato row yet — auto-create one keyed to the LeadByte id. We don't
  // know the name/vertical until LeadByte sync runs, so leave them blank;
  // the next sync fills them in.
  if (!row) {
    const inserted = await db
      .insert(campaignsTable)
      .values({
        leadbyteCampaignId: id,
        name: 'Pending sync',
        costPerLead: input.costPerLead != null ? String(input.costPerLead) : null,
      })
      .returning();
    row = inserted[0];
  } else {
    const patch: Partial<typeof row> = { updatedAt: new Date() };
    if (input.costPerLead !== undefined) {
      patch.costPerLead = input.costPerLead != null ? String(input.costPerLead) : null;
    }
    const updated = await db
      .update(campaignsTable)
      .set(patch)
      .where(eq(campaignsTable.id, row.id))
      .returning();
    row = updated[0];
  }

  return {
    id: row.id,
    costPerLead: row.costPerLead ? Number(row.costPerLead) : null,
  };
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
  /**
   * Leads in the previous calendar month — exposed so the dashboard's
   * window-filter dropdown can pivot the Campaign Sources pie chart to
   * "Last month" without an extra LeadByte round-trip (the BE already
   * caches /reports/campaign?last_month for the campaign-table view).
   * Optional for back-compat: older snapshots without it treat as 0.
   */
  leadsLastMonth?: number;
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
  /** Sato DB UUID — distinct from `id` which is the LeadByte campaign id.
   * Used by the frontend when PATCH-ing fields that live in Stato DB
   * (cost_per_lead, etc.), since LeadByte is the source of truth for the
   * read path but Stato owns the editable metadata. */
  satoId: string | null;
  /** Sam's #41 — manual supplier cost-per-lead target. Distinct from the
   * computed `cpl` (which is totalCost/totalLeads from LeadByte aggregates). */
  costPerLead: number | null;
  /** Sam's Day 1 inversion — buyers linked to this campaign via
   * `client_campaigns`. Empty array when none linked yet. */
  linkedClients: Array<{
    clientId: string;
    clientName: string;
    leadPrice: number | null;
    currency: string;
    status: string;
  }>;
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
    cached('lb:report:last_month:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('last_month')),
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
  const lastMonthReport = pickOrEmpty(settled[3], 'last_month');
  const ytdReport = pickOrEmpty(settled[4], 'ytd');

  // The report rows are keyed by campaign NAME (LeadByte's choice), so we
  // build name-keyed maps for fast lookup per campaign.
  type ReportRow = (typeof todayReport)[number];
  const byName = (rows: ReportRow[]) => new Map(rows.map((r) => [r.campaign, r] as const));
  const todayByName = byName(todayReport);
  const weekByName = byName(weekReport);
  const monthByName = byName(monthReport);
  const lastMonthByName = byName(lastMonthReport);
  const ytdByName = byName(ytdReport);

  return campaigns.map((c): CampaignSummary => {
    const today = todayByName.get(c.name);
    const week = weekByName.get(c.name);
    const month = monthByName.get(c.name);
    const lastMonth = lastMonthByName.get(c.name);
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
    // last_month + this_month covers ~60 days with zero overlap. Was
    // [today, week, month] which double-counted today's leads (today ⊆
    // this_week ⊆ this_month).
    const fallbackRows = [month, lastMonth];
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
      // LeadByte's /campaigns endpoint doesn't carry a vertical column and
      // Sam hasn't backfilled the Sato `campaigns.vertical` field — so the
      // Campaign Sources pie chart was lumping every campaign into "Other".
      // pickVertical() keeps any real DB value if present, otherwise derives
      // from the name (Solar, Insulation, Hearing Aids, …).
      vertical: pickVertical(c.name, c.vertical),
      status: c.status,
      campaignType: resolveCampaignType(c.id, typeMap),
      leadPrice: c.leadPrice,
      currency: c.currency,
      totalLeads,
      leadsToday: today?.leads ?? 0,
      leadsThisWeek: week?.leads ?? 0,
      leadsThisMonth: month?.leads ?? 0,
      leadsLastMonth: lastMonth?.leads ?? 0,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      cpl: Math.round(cpl * 100) / 100,
      margin: Math.round(margin * 10) / 10,
      startDate: c.startDate,
    };
  });
}

/**
 * Load Sato-side campaign metadata (cost_per_lead + linked clients) for a
 * LeadByte campaign id. Slice 2 introduces vertical-only campaigns that
 * exist in Sato DB but not LeadByte — for those, the caller looks up by
 * Sato UUID via a different path. This helper handles the common case.
 */
async function loadSatoCampaignMetadata(leadbyteId: string): Promise<{
  satoId: string | null;
  costPerLead: number | null;
  linkedClients: CampaignDetail['linkedClients'];
}> {
  const [row] = await db
    .select({ id: campaignsTable.id, costPerLead: campaignsTable.costPerLead })
    .from(campaignsTable)
    .where(eq(campaignsTable.leadbyteCampaignId, leadbyteId));
  if (!row) return { satoId: null, costPerLead: null, linkedClients: [] };

  const linksRows = await db
    .select({
      clientId: clientCampaigns.clientId,
      clientName: clients.companyName,
      leadPrice: clientCampaigns.leadPrice,
      currency: clientCampaigns.currency,
      status: clientCampaigns.status,
    })
    .from(clientCampaigns)
    .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
    .where(eq(clientCampaigns.campaignId, row.id));

  return {
    satoId: row.id,
    costPerLead: row.costPerLead ? Number(row.costPerLead) : null,
    linkedClients: linksRows.map((l) => ({
      clientId: l.clientId,
      clientName: l.clientName,
      leadPrice: l.leadPrice ? Number(l.leadPrice) : null,
      currency: l.currency ?? 'GBP',
      status: l.status ?? 'active',
    })),
  };
}

/**
 * Per-buyer delivery rules for a campaign, including the day/week/month/total
 * caps Sam called out in the 2026-05-15 Loom as "missing from the UI".
 * Surfaced read-only — LeadByte's UI remains the write surface.
 *
 * Accepts either a Sato uuid or a LeadByte campaign id (FE convention).
 * Returns `null` when the campaign can't be resolved, `[]` when the campaign
 * exists but has no `leadbyteCampaignId` set (local-only campaigns).
 */
export interface CampaignDelivery {
  id: string;
  reference: string | null;
  status: string | null;
  buyer: { id: string | null; name: string } | null;
  caps: { day: number | null; week: number | null; month: number | null; total: number | null };
}

export async function getCampaignDeliveries(idOrLeadbyteId: string): Promise<CampaignDelivery[] | null> {
  // Resolve to the LeadByte campaign id — that's what /deliveries returns
  // on `d.campaign.id`. If the caller passed a uuid, look up the LB id from
  // our campaigns row; if they passed the LB id directly (FE convention),
  // use it as-is.
  let leadbyteCampaignId: string | null = null;
  const { isUuid } = await import('../utils/zod-helpers.js');
  if (isUuid(idOrLeadbyteId)) {
    const [row] = await db
      .select({ leadbyteCampaignId: campaignsTable.leadbyteCampaignId })
      .from(campaignsTable)
      .where(eq(campaignsTable.id, idOrLeadbyteId));
    if (!row) return null;
    leadbyteCampaignId = row.leadbyteCampaignId ?? null;
  } else {
    leadbyteCampaignId = idOrLeadbyteId;
  }

  if (!leadbyteCampaignId) return [];

  const deliveries = await leadbyte.getDeliveries();
  return deliveries
    .filter((d) => String(d.campaign?.id ?? '') === String(leadbyteCampaignId))
    .map((d) => ({
      id: String(d.id),
      reference: d.reference ?? null,
      status: d.status ?? null,
      buyer: d.buyer
        ? { id: d.buyer.id != null ? String(d.buyer.id) : null, name: d.buyer.name }
        : null,
      caps: {
        day: d.caps?.day ?? null,
        week: d.caps?.week ?? null,
        month: d.caps?.month ?? null,
        total: d.caps?.total ?? null,
      },
    }));
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
    deliveries, suppliers, satoMeta,
    todayReport, yesterdayReport, weekReport, lastWeekReport,
    monthReport, lastMonthReport, ytdReport,
  ] = await Promise.all([
    // LeadByte's /reports/leadactivity silently returns 0 rows for the
    // arbitrary-days-range overload (verified 2026-05-17). Pull last_month
    // + this_month named windows and merge — same ~30 days of coverage
    // but actually populated.
    cached(`lb:deliveries:${id}:30d:v2`, PER_CAMPAIGN_TTL, async () => {
      const [last, current] = await Promise.all([
        leadbyte.getDeliveryReports(id, 'last_month'),
        leadbyte.getDeliveryReports(id, 'this_month'),
      ]);
      return [...last, ...current];
    }),
    cached(`lb:suppliers:${id}:30d:v1`, PER_CAMPAIGN_TTL, () => leadbyte.getSuppliers(id)),
    // Sato-side metadata is intentionally NOT cached — cost_per_lead is
    // edited inline by users and stale reads break the UX immediately.
    // Sub-millisecond DB lookup so caching would add nothing anyway.
    loadSatoCampaignMetadata(id),
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

  // Same ytd-is-empty fallback used in listCampaigns: LeadByte's ytd window
  // returns zeros for some campaigns even when last_month + this_month
  // report real activity. Sum only the non-overlapping windows so we don't
  // triple-count today's leads (today ⊆ this_week ⊆ this_month).
  const sumWindows = (
    rows: Array<typeof todayRow | undefined>,
    key: 'leads' | 'revenue' | 'payout' | 'emailCost' | 'smsCost' | 'validationCost',
  ) => rows.reduce((sum, r) => sum + ((r?.[key] as number | undefined) ?? 0), 0);
  const ytdHasData = (ytdRow?.leads ?? 0) > 0 || (ytdRow?.revenue ?? 0) > 0;
  // last_month + this_month covers ~60 days with zero overlap. Was
  // [today, week, month, last_month] which triple-counted today's leads.
  const fallbackRows = [monthRow, lastMonthRow];

  const totalLeads = ytdHasData ? (ytdRow?.leads ?? 0) : sumWindows(fallbackRows, 'leads');
  const leadsToday = todayRow?.leads ?? 0;
  const leadsThisWeek = weekRow?.leads ?? 0;
  const leadsThisMonth = monthRow?.leads ?? 0;
  const totalRevenue = ytdHasData ? (ytdRow?.revenue ?? 0) : sumWindows(fallbackRows, 'revenue');
  const fallbackCost =
    sumWindows(fallbackRows, 'payout') +
    sumWindows(fallbackRows, 'emailCost') +
    sumWindows(fallbackRows, 'smsCost') +
    sumWindows(fallbackRows, 'validationCost');
  const totalCost = ytdHasData
    ? (ytdRow?.payout ?? 0) + (ytdRow?.emailCost ?? 0) + (ytdRow?.smsCost ?? 0) + (ytdRow?.validationCost ?? 0)
    : fallbackCost;
  const cpl = totalLeads > 0 ? totalCost / totalLeads : 0;
  const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

  return {
    id: campaign.id,
    satoId: satoMeta.satoId,
    costPerLead: satoMeta.costPerLead,
    linkedClients: satoMeta.linkedClients,
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
