import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
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
  catchrUrl: string | null;
  isActive: boolean;
  totalSpend: number;
  totalLeads: number;
  cpl: number;
  createdAt: string;
}

type SourceRow = typeof trafficSources.$inferSelect;

function toDto(row: SourceRow): TrafficSource {
  const totalSpend = Number(row.totalSpend ?? 0);
  const totalLeads = row.totalLeads ?? 0;
  return {
    id: row.id,
    campaignId: row.campaignId ?? '',
    name: row.name,
    platform: row.platform ?? '',
    catchrUrl: row.catchrUrl,
    isActive: row.isActive,
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalLeads,
    cpl: totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

export async function listSourcesForCampaign(
  campaignId: string,
  _requester: AuthPayload,
): Promise<TrafficSource[]> {
  // LeadByte campaigns have numeric IDs and no internal traffic-source rows.
  // Skip the DB query before Postgres rejects the non-uuid value.
  if (!isUuid(campaignId)) return [];

  const rows = await db
    .select()
    .from(trafficSources)
    .where(eq(trafficSources.campaignId, campaignId))
    .orderBy(desc(trafficSources.totalSpend));
  return rows.map(toDto);
}

export async function countSourcesForCampaign(campaignId: string): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trafficSources)
    .where(and(eq(trafficSources.campaignId, campaignId), eq(trafficSources.isActive, true)));
  return row?.count ?? 0;
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
