import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { isUuid } from '../utils/zod-helpers.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Per-campaign traffic source (e.g. "google-Lasting Power of Attorney (UK)").
 * Mirrors the Leadreports.io model where each source has its own Catchr URL
 * for ad-spend retrieval.
 */
export interface TrafficSource {
  id: string;
  campaignId: string;
  name: string;
  platform: string;
  accountId: string;
  catchrUrl: string | null;
  isActive: boolean;
  totalSpend: number;
  totalLeads: number;
  cpl: number;
  // Sam Loom #42-46: leadreports.io-style row needs revenue + net profit
  // alongside spend. Revenue = leadPrice × totalLeads (campaign-level proxy
  // until per-buyer breakdown is wired up via client_campaigns).
  revenue: number;
  netProfit: number;
  createdAt: string;
}

type SourceRow = typeof trafficSources.$inferSelect;

function toDto(row: SourceRow, leadPrice = 0): TrafficSource {
  const totalSpend = Number(row.totalSpend ?? 0);
  const totalLeads = row.totalLeads ?? 0;
  const revenue = Math.round(leadPrice * totalLeads * 100) / 100;
  return {
    id: row.id,
    campaignId: row.campaignId ?? '',
    name: row.name,
    platform: row.platform ?? '',
    accountId: row.accountId ?? '',
    catchrUrl: row.catchrUrl,
    isActive: row.isActive,
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalLeads,
    cpl: totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0,
    revenue,
    netProfit: Math.round((revenue - totalSpend) * 100) / 100,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

async function leadPriceForCampaign(campaignId: string): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const [row] = await db
    .select({ leadPrice: campaignsTable.leadPrice })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));
  return row?.leadPrice ? Number(row.leadPrice) : 0;
}

export async function listSourcesForCampaign(
  campaignId: string,
  _requester: AuthPayload,
): Promise<TrafficSource[]> {
  // LeadByte campaigns have numeric IDs and no internal traffic-source rows.
  // Skip the DB query before Postgres rejects the non-uuid value.
  if (!isUuid(campaignId)) return [];

  // Load lead price + sources in parallel; both are tiny single-table reads.
  const [leadPrice, rows] = await Promise.all([
    leadPriceForCampaign(campaignId),
    db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.campaignId, campaignId))
      .orderBy(desc(trafficSources.totalSpend)),
  ]);
  return rows.map((r) => toDto(r, leadPrice));
}

export async function countSourcesForCampaign(campaignId: string): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trafficSources)
    .where(and(eq(trafficSources.campaignId, campaignId), eq(trafficSources.isActive, true)));
  return row?.count ?? 0;
}

// ─── CRUD (Sam Loom #42-46 — leadreports.io-style mapping rows) ─────────────
//
// Each traffic source is a single row in Sam's mental model: pick the
// supplier (Facebook / Google / Bing / TikTok / Taboola / etc) → pick its
// Catchr NCP URL so ad-spend can be fetched → see leads (LeadByte) and
// revenue (lead_price × leads) → net profit (revenue - spend).
//
// Spend + lead counts are stored as snapshot columns (`total_spend`,
// `total_leads`) and refreshed by the Catchr/LeadByte sync workers — keeps
// the dashboard fast and lets the UI show numbers without round-tripping
// to upstream APIs on every load.

export interface CreateTrafficSourceInput {
  name: string;
  platform?: string;
  accountId?: string;
  catchrUrl?: string;
  isActive?: boolean;
}

export interface UpdateTrafficSourceInput {
  name?: string;
  platform?: string;
  accountId?: string;
  catchrUrl?: string | null;
  isActive?: boolean;
  totalSpend?: number;
  totalLeads?: number;
}

export async function createSource(
  campaignId: string,
  input: CreateTrafficSourceInput,
  _requester: AuthPayload,
): Promise<TrafficSource | null> {
  if (!isUuid(campaignId)) return null;
  const [row] = await db
    .insert(trafficSources)
    .values({
      campaignId,
      name: input.name,
      platform: input.platform || null,
      accountId: input.accountId || null,
      catchrUrl: input.catchrUrl || null,
      isActive: input.isActive ?? true,
    })
    .returning();
  const leadPrice = await leadPriceForCampaign(campaignId);
  return toDto(row, leadPrice);
}

export async function updateSource(
  campaignId: string,
  sourceId: string,
  input: UpdateTrafficSourceInput,
  _requester: AuthPayload,
): Promise<TrafficSource | null> {
  if (!isUuid(campaignId) || !isUuid(sourceId)) return null;
  const patch: Partial<SourceRow> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.platform !== undefined) patch.platform = input.platform || null;
  if (input.accountId !== undefined) patch.accountId = input.accountId || null;
  if (input.catchrUrl !== undefined) patch.catchrUrl = input.catchrUrl || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.totalSpend !== undefined) patch.totalSpend = String(input.totalSpend);
  if (input.totalLeads !== undefined) patch.totalLeads = input.totalLeads;

  const [row] = await db
    .update(trafficSources)
    .set(patch)
    .where(and(eq(trafficSources.id, sourceId), eq(trafficSources.campaignId, campaignId)))
    .returning();
  if (!row) return null;
  const leadPrice = await leadPriceForCampaign(campaignId);
  return toDto(row, leadPrice);
}

export async function deleteSource(
  campaignId: string,
  sourceId: string,
  _requester: AuthPayload,
): Promise<boolean> {
  if (!isUuid(campaignId) || !isUuid(sourceId)) return false;
  const deleted = await db
    .delete(trafficSources)
    .where(and(eq(trafficSources.id, sourceId), eq(trafficSources.campaignId, campaignId)))
    .returning({ id: trafficSources.id });
  return deleted.length > 0;
}

/**
 * Counts per every campaign — used to avoid N+1 lookups on the campaigns list page.
 */
export async function sourceCountsByCampaign(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      campaignId: trafficSources.campaignId,
      count: sql<number>`count(*)::int`,
    })
    .from(trafficSources)
    .where(eq(trafficSources.isActive, true))
    .groupBy(trafficSources.campaignId);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.campaignId) out[r.campaignId] = r.count;
  }
  return out;
}
