import { eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import { cached } from '../utils/cache.js';
import type { AuthPayload } from '../types/index.js';

// LeadByte campaign aggregates change slowly relative to dashboard load
// frequency. Caching them for 5 minutes is the sweet spot:
// - Long enough that idle periods (lunch break, AFK, async work) don't flush
//   the cache and force the next user to wait 1.5-2s on a cold miss.
// - Short enough that sync changes (hourly LeadByte sync at minute 0/30)
//   show up within ~5 min in the worst case.
// - The 45s prewarm worker refreshes the cache before TTL expires when
//   running, but if the worker is down for any reason, users still get
//   acceptable freshness from the longer TTL alone.
const CAMPAIGN_LIST_TTL_SECONDS = 300;
const DELIVERY_REPORT_TTL_SECONDS = 300;
const TYPE_MAP_TTL_SECONDS = 600;

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

export interface CampaignDetail extends CampaignSummary {
  leadDeliveries: {
    date: string;
    leadCount: number;
    validLeads: number;
    invalidLeads: number;
    revenue: number;
    cost: number;
  }[];
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

  // /reports/campaign for the 4 windows. Fetched SEQUENTIALLY because the
  // 4-in-parallel burst was empirically getting rate-limited / partially-empty
  // responses from LeadByte (some windows came back as []). Sequential adds
  // ~1.5s wall-time on a cold-cache request, but each result is cached
  // independently, so warm cache (the common case after first user) stays
  // ~50ms total. Combined with the never-cache-empty rule in cached(), we
  // tolerate transient LeadByte blips without poisoning the cache.
  const todayReport = await cached('lb:report:today:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('today'));
  const weekReport = await cached('lb:report:week:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_week'));
  const monthReport = await cached('lb:report:month:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('this_month'));
  const ytdReport = await cached('lb:report:ytd:v5', DELIVERY_REPORT_TTL_SECONDS, () => leadbyte.getCampaignReport('ytd'));

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

    // Revenue/cost/margin use the YTD figures so the table shows lifetime totals
    // (matches what Sam expects from the LeadByte UI). Leads have separate
    // today/week/month columns and the totalLeads column shows YTD.
    const totalLeads = ytd?.leads ?? 0;
    const totalRevenue = ytd?.revenue ?? 0;
    const totalCost = (ytd?.payout ?? 0) + (ytd?.emailCost ?? 0) + (ytd?.smsCost ?? 0) + (ytd?.validationCost ?? 0);
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

  const deliveries = await leadbyte.getDeliveryReports(id, 30);
  const suppliers = await leadbyte.getSuppliers(id);

  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const leadsToday = deliveries.filter((d) => d.date === today).reduce((sum, d) => sum + d.leadCount, 0);
  const leadsThisWeek = deliveries.filter((d) => d.date >= weekAgo).reduce((sum, d) => sum + d.leadCount, 0);
  const leadsThisMonth = deliveries.filter((d) => d.date >= monthAgo).reduce((sum, d) => sum + d.leadCount, 0);
  const totalLeads = deliveries.reduce((sum, d) => sum + d.leadCount, 0);
  const totalRevenue = deliveries.reduce((sum, d) => sum + d.revenue, 0);
  const totalCost = deliveries.reduce((sum, d) => sum + d.cost, 0);
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
