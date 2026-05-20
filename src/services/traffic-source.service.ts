import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { isUuid } from '../utils/zod-helpers.js';
import { resolveSatoCampaignId } from '../utils/resolve-campaign-id.js';
import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import { logger } from '../utils/logger.js';
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
  /** Legacy "primary" Catchr account id. New code should read `accountIds`
   *  which carries the full set (primary + additional). Kept on the DTO
   *  for back-compat with FE callers that still render this column. */
  accountId: string;
  /** Full set of Catchr account ids whose spend rolls up under this source.
   *  Includes the legacy `accountId` when set, plus any additional ids
   *  picked via the multi-select. */
  accountIds: string[];
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

/**
 * Build the de-duplicated set of Catchr account ids associated with a row.
 * Unions the legacy single `accountId` column with the new `accountIds[]`
 * jsonb array so callers see one consistent list regardless of which
 * shape was used when the row was created.
 */
function allAccountIds(row: SourceRow): string[] {
  const extras = Array.isArray(row.accountIds) ? row.accountIds.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
  const primary = row.accountId && row.accountId.length > 0 ? [row.accountId] : [];
  return Array.from(new Set([...primary, ...extras]));
}

function toDto(
  row: SourceRow,
  leadPrice = 0,
  liveSpend?: number,
  liveLeads?: number,
): TrafficSource {
  const totalSpend = liveSpend !== undefined ? liveSpend : Number(row.totalSpend ?? 0);
  const totalLeads = liveLeads !== undefined ? liveLeads : (row.totalLeads ?? 0);
  const revenue = Math.round(leadPrice * totalLeads * 100) / 100;
  return {
    id: row.id,
    campaignId: row.campaignId ?? '',
    name: row.name,
    platform: row.platform ?? '',
    accountId: row.accountId ?? '',
    accountIds: allAccountIds(row),
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
  // FE passes either the Sato UUID or LeadByte's numeric campaign id ("38").
  // Resolve to Sato UUID first so the DB query has a valid FK to match.
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return [];

  // Get the LeadByte id so we can join ad_spend on it (ad_spend.campaign_id
  // stores the platform-side campaign id Catchr ingested, which is the
  // LeadByte numeric id for our setup).
  const [campRow] = await db
    .select({
      leadPrice: campaignsTable.leadPrice,
      leadbyteCampaignId: campaignsTable.leadbyteCampaignId,
    })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, satoId));
  const leadPrice = campRow?.leadPrice ? Number(campRow.leadPrice) : 0;
  const lbCampaignId = campRow?.leadbyteCampaignId ?? '';

  // Pull traffic source rows + live ad-spend aggregates + lead deliveries
  // total in parallel. Without this join the totalSpend column stays at
  // its 0 default forever (nothing writes to it on the sync path).
  //
  // Attribution model (T1, 2026-05-20): the outer `where trafficSources
  // .campaignId = satoId` already pre-filters rows to this campaign, so
  // summing ad_spend by (platform, account_id) and then mapping back to
  // each source row attributes correctly without an explicit
  // ad_spend.campaign_id filter. Cross-campaign account reuse is
  // intentionally allowed at the source-row level (Sam can link the
  // same Facebook account to multiple campaigns when needed); double-
  // counting across campaigns is surfaced via the "Unlinked Spend"
  // diagnostic on /campaigns rather than hidden by query filters.
  const adSpendWindowStart = new Date();
  adSpendWindowStart.setDate(adSpendWindowStart.getDate() - 30);
  const adSpendWindowIso = adSpendWindowStart.toISOString().slice(0, 10);
  const [rows, spendRows, leadAgg] = await Promise.all([
    db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.campaignId, satoId))
      .orderBy(desc(trafficSources.totalSpend)),
    // Sum trailing-30-day ad_spend by (platform, account_id). Empty for
    // platforms/accounts we don't sync — sources pointing at unsynced or
    // dormant accounts naturally land at £0.
    db
      .select({
        platform: adSpend.platform,
        accountId: adSpend.accountId,
        spend: sql<string>`coalesce(sum(${adSpend.spend}::numeric), 0)::text`,
      })
      .from(adSpend)
      .where(sql`${adSpend.date} >= ${adSpendWindowIso}::date`)
      .groupBy(adSpend.platform, adSpend.accountId),
    // Campaign-level total leads. Per-source attribution isn't possible from
    // the LeadByte aggregate report, so for now every source on the same
    // campaign shows the same lead count (shared denominator).
    db
      .select({ leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int` })
      .from(leadDeliveries)
      .where(eq(leadDeliveries.campaignId, satoId)),
  ]);
  // Suppress unused-var TS warning during transition — lbCampaignId may
  // still be used by callers reading the export.
  void lbCampaignId;

  const spendByKey = new Map<string, number>();
  for (const s of spendRows) {
    spendByKey.set(`${s.platform}|${s.accountId}`, Number(s.spend));
  }

  // Local lead_deliveries only gets populated for single-linked-client
  // campaigns (Piece 3). For everything else — most campaigns currently —
  // the local sum is 0 even when LeadByte has thousands of real leads. Fall
  // back to LeadByte's last_month + this_month windowed report so the
  // sources table doesn't sit at 0 leads next to a non-empty
  // /reports/campaign result on the same page.
  let totalLeadsForCampaign = leadAgg[0]?.leads ?? 0;
  if (totalLeadsForCampaign === 0 && rows.length > 0 && lbCampaignId) {
    try {
      const [thisMonth, lastMonth] = await Promise.all([
        leadbyte.getCampaignReport('this_month'),
        leadbyte.getCampaignReport('last_month'),
      ]);
      // /reports/campaign rows key by campaign name, which we don't have here
      // — but we DO have the leadbyte_campaign_id. Pull the campaign name
      // from the resolved row, then sum matching rows.
      const [campNameRow] = await db
        .select({ name: campaignsTable.name })
        .from(campaignsTable)
        .where(eq(campaignsTable.id, satoId));
      const campName = campNameRow?.name;
      if (campName) {
        const thisMonthLeads = thisMonth.find((r) => r.campaign === campName)?.leads ?? 0;
        const lastMonthLeads = lastMonth.find((r) => r.campaign === campName)?.leads ?? 0;
        totalLeadsForCampaign = thisMonthLeads + lastMonthLeads;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), satoId },
        'traffic-source: LeadByte lead fallback failed — using local 0',
      );
    }
  }

  return rows.map((r) => {
    // Sum live spend across every Catchr account id linked to this row
    // (legacy primary + new accountIds[]). Each (platform, accountId)
    // pair contributes its 30-day ad_spend total; missing pairs add 0.
    const ids = allAccountIds(r);
    const platform = r.platform ?? '';
    let liveSpend: number | undefined;
    if (ids.length > 0) {
      liveSpend = 0;
      for (const accId of ids) {
        liveSpend += spendByKey.get(`${platform}|${accId}`) ?? 0;
      }
    }
    return toDto(
      r,
      leadPrice,
      // Override the static columns with live aggregates when we have them.
      liveSpend !== undefined ? liveSpend : Number(r.totalSpend ?? 0),
      // Leads stay campaign-total until per-source attribution exists.
      totalLeadsForCampaign,
    );
  });
}

export async function countSourcesForCampaign(campaignId: string): Promise<number> {
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trafficSources)
    .where(and(eq(trafficSources.campaignId, satoId), eq(trafficSources.isActive, true)));
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
  /** Primary Catchr account id — legacy single-field. Either set this OR
   *  pass everything via `accountIds` (or both: it'll be deduped). */
  accountId?: string;
  /** Optional additional Catchr account ids. Lets one traffic source row
   *  roll up spend from multiple ad accounts on the same platform
   *  (e.g. Solar Panels UK pulling from Solar Incentives + TheSolarGeeks +
   *  Solar Discounts + MYSOLAR all at once). */
  accountIds?: string[];
  catchrUrl?: string;
  isActive?: boolean;
}

export interface UpdateTrafficSourceInput {
  name?: string;
  platform?: string;
  accountId?: string;
  accountIds?: string[];
  catchrUrl?: string | null;
  isActive?: boolean;
  totalSpend?: number;
  totalLeads?: number;
}

/** Drop blanks + dedupe an input array of account ids. */
function sanitizeAccountIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export async function createSource(
  campaignId: string,
  input: CreateTrafficSourceInput,
  _requester: AuthPayload,
): Promise<TrafficSource | null> {
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return null;
  const sanitized = sanitizeAccountIds(input.accountIds);
  const [row] = await db
    .insert(trafficSources)
    .values({
      campaignId: satoId,
      name: input.name,
      platform: input.platform || null,
      accountId: input.accountId || null,
      accountIds: sanitized,
      catchrUrl: input.catchrUrl || null,
      isActive: input.isActive ?? true,
    })
    .returning();
  const leadPrice = await leadPriceForCampaign(satoId);
  return toDto(row, leadPrice);
}

export async function updateSource(
  campaignId: string,
  sourceId: string,
  input: UpdateTrafficSourceInput,
  _requester: AuthPayload,
): Promise<TrafficSource | null> {
  if (!isUuid(sourceId)) return null;
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return null;
  const patch: Partial<SourceRow> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.platform !== undefined) patch.platform = input.platform || null;
  if (input.accountId !== undefined) patch.accountId = input.accountId || null;
  if (input.accountIds !== undefined) patch.accountIds = sanitizeAccountIds(input.accountIds);
  if (input.catchrUrl !== undefined) patch.catchrUrl = input.catchrUrl || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.totalSpend !== undefined) patch.totalSpend = String(input.totalSpend);
  if (input.totalLeads !== undefined) patch.totalLeads = input.totalLeads;

  const [row] = await db
    .update(trafficSources)
    .set(patch)
    .where(and(eq(trafficSources.id, sourceId), eq(trafficSources.campaignId, satoId)))
    .returning();
  if (!row) return null;
  const leadPrice = await leadPriceForCampaign(satoId);
  return toDto(row, leadPrice);
}

export async function deleteSource(
  campaignId: string,
  sourceId: string,
  _requester: AuthPayload,
): Promise<boolean> {
  if (!isUuid(sourceId)) return false;
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return false;
  // Idempotent — return true even if 0 rows deleted (row already gone or
  // never existed for this campaign). REST DELETE convention + avoids the
  // "Source not found" toast spam when the FE double-clicks the trash icon.
  // Only returns false when the campaign itself is unknown (above).
  await db
    .delete(trafficSources)
    .where(and(eq(trafficSources.id, sourceId), eq(trafficSources.campaignId, satoId)));
  return true;
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
