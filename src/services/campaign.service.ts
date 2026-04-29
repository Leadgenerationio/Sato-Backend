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
  const [campaigns, typeMapEntries] = await Promise.all([
    cached('lb:campaigns', CAMPAIGN_LIST_TTL_SECONDS, () => leadbyte.getCampaigns()),
    // Map can't JSON-serialize, so cache as an entries array and rebuild.
    cached('campaigns:type-map', TYPE_MAP_TTL_SECONDS, async () => {
      const m = await loadCampaignTypeMap();
      return Array.from(m.entries());
    }),
  ]);
  const typeMap = new Map(typeMapEntries);

  // Compute date boundaries once — they don't change per-campaign.
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  // Fetch all delivery reports in parallel, each Redis-cached so repeat
  // dashboard loads within 60s are near-instant. Cache key includes the
  // campaign id so each campaign's report is its own entry.
  const deliveriesPerCampaign = await Promise.all(
    campaigns.map((c) =>
      cached(`lb:deliveries:${c.id}:30d`, DELIVERY_REPORT_TTL_SECONDS, () =>
        leadbyte.getDeliveryReports(c.id, 30),
      ),
    ),
  );

  return campaigns.map((c, i): CampaignSummary => {
    const deliveries = deliveriesPerCampaign[i];

    const leadsToday = deliveries.filter((d) => d.date === today).reduce((sum, d) => sum + d.leadCount, 0);
    const leadsThisWeek = deliveries.filter((d) => d.date >= weekAgo).reduce((sum, d) => sum + d.leadCount, 0);
    const leadsThisMonth = deliveries.filter((d) => d.date >= monthAgo).reduce((sum, d) => sum + d.leadCount, 0);
    const totalLeads = deliveries.reduce((sum, d) => sum + d.leadCount, 0);
    const totalRevenue = deliveries.reduce((sum, d) => sum + d.revenue, 0);
    const totalCost = deliveries.reduce((sum, d) => sum + d.cost, 0);
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
      leadsToday,
      leadsThisWeek,
      leadsThisMonth,
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
