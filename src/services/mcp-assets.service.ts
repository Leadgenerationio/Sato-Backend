import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { getSignedDownloadUrl, objectExists } from '../integrations/r2/r2-client.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { ApiError } from '../utils/api-error.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { creativeInBusiness, SHARED_SHOWS_UNDER_EVERY_BUYER } from './creative-library.service.js';
import { resolveR2Location } from './creative.service.js';
import { toAdLinkDto, type AdLinkDto } from './creative-ad-links.service.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { clientColumnInScope } from './key-client-scope.service.js';

// MCP spec v1.0 list_assets and get_asset. Read only. Archived assets are
// hidden unless includeArchived is sent (spec test 13); the file is never touched.

export interface Page<T> { items: T[]; nextCursor: string | null }

const badCursor = () => new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] });

/**
 * The cursor is the sort key of the last row sent (not a row count), so the next page starts right after it even when
 * the bot changes assets between pages: linking the assets of a "not yet linked" list removes them from that list, and
 * a row offset would then skip the next 25 unseen assets.
 */
interface AssetCursor { s: 'created' | 'name'; k: string; i: string }
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseCursor(cursor: string | undefined, sort: 'created' | 'name'): AssetCursor | null {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<AssetCursor>;
    const keyOk = typeof c.k === 'string' && c.k.length <= 300 && (sort === 'name' || TIMESTAMP_RE.test(c.k));
    if (c.s === sort && keyOk && typeof c.i === 'string' && UUID_RE.test(c.i)) return c as AssetCursor;
  } catch { /* fall through */ }
  throw badCursor();
}

export interface AssetListItem {
  creativeId: string;
  name: string;
  mediaType: string | null;
  thumbnailUrl: string | null;
  client: { clientId: string; name: string } | null;
  campaign: { campaignId: string; name: string } | null;
  approvalStatus: string;
  fileStatus: string;
  adLinkCount: number;
  archivedAt: string | null;
  createdAt: string | null;
}

export interface ListAssetsFilters {
  clientId?: string; campaignId?: string; platform?: string; platformAccountId?: string; platformAdId?: string; landingPageId?: string;
  mediaType?: string; approvalStatus?: string; hasAdLink?: boolean; q?: string; from?: string; to?: string;
  includeArchived?: boolean; sort?: 'created' | 'name'; limit?: number; cursor?: string;
}

export async function listAssets(businessId: string, f: ListAssetsFilters): Promise<Page<AssetListItem>> {
  const limit = Math.min(100, Math.max(1, f.limit ?? 25));
  const sort = f.sort === 'name' ? 'name' : 'created';
  const after = parseCursor(f.cursor, sort);
  const where: SQL[] = [eq(creatives.isDeleted, false), creativeInBusiness(businessId)];
  if (!f.includeArchived) where.push(isNull(creatives.archivedAt));
  const inScope = clientColumnInScope(creatives.clientId); // a key limited to some clients lists only their assets
  if (inScope) where.push(inScope);
  if (f.clientId) {
    where.push(SHARED_SHOWS_UNDER_EVERY_BUYER
      ? or(eq(creatives.clientId, f.clientId), and(isNull(creatives.clientId), sql`${creatives.campaignId} in (select cc.campaign_id from ${clientCampaigns} cc where cc.client_id = ${f.clientId})`))!
      : eq(creatives.clientId, f.clientId));
  }
  if (f.campaignId) where.push(eq(creatives.campaignId, f.campaignId));
  if (f.platform) where.push(eq(creatives.platform, toSpecPlatform(normalisePlatform(f.platform))));
  if (f.platformAccountId) where.push(eq(creatives.platformAccountId, normaliseAccountId(f.platform ?? 'meta', f.platformAccountId)));
  if (f.platformAdId) {
    where.push(or(
      eq(creatives.platformAdId, f.platformAdId),
      sql`exists (select 1 from ${creativeAdLinks} l where l.creative_id = ${creatives.id} and l.platform_ad_id = ${f.platformAdId} and l.status <> 'removed')`,
    )!);
  }
  if (f.landingPageId) where.push(eq(creatives.landingPageId, f.landingPageId));
  if (f.mediaType) where.push(eq(creatives.type, f.mediaType));
  if (f.approvalStatus) where.push(sql`${creatives.status}::text = ${f.approvalStatus}`);
  if (f.hasAdLink !== undefined) {
    const has = sql`exists (select 1 from ${creativeAdLinks} l where l.creative_id = ${creatives.id} and l.status <> 'removed')`;
    where.push(f.hasAdLink ? has : sql`not ${has}`);
  }
  if (f.from) where.push(sql`${creatives.createdAt} >= ${f.from}::date`);
  if (f.to) where.push(sql`${creatives.createdAt} < (${f.to}::date + interval '1 day')`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(creatives.name, like), ilike(creatives.headline, like), ilike(creatives.bodyText, like), ilike(creatives.platformAdId, like), ilike(creatives.platformCreativeId, like))!);
  }
  // Rows with no creation time sort as the oldest, so the sort key is never null and the cursor can compare on it.
  const createdKey = sql`coalesce(${creatives.createdAt}, 'epoch'::timestamp)`;
  const order = sort === 'name' ? [asc(creatives.name), asc(creatives.id)] : [desc(createdKey), desc(creatives.id)];
  if (after) {
    where.push(sort === 'name'
      ? sql`(${creatives.name}, ${creatives.id}) > (${after.k}, ${after.i}::uuid)`
      : sql`(${createdKey}, ${creatives.id}) < (${after.k}::timestamp, ${after.i}::uuid)`);
  }

  const rows = await db
    .select({
      cr: creatives,
      sortKey: sort === 'name' ? sql<string>`${creatives.name}` : sql<string>`${createdKey}::text`,
      clientName: clients.companyName,
      campaignName: campaigns.name,
      // Written out by hand: inside a select list Drizzle drops the table name.
      adLinkCount: sql<number>`(select count(*)::int from creative_ad_links l where l.creative_id = ${sql.raw('"creatives"."id"')} and l.status <> 'removed')`,
    })
    .from(creatives)
    .leftJoin(clients, eq(clients.id, creatives.clientId))
    .leftJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .where(and(...where)).orderBy(...order).limit(limit + 1);

  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map(async (r): Promise<AssetListItem> => ({
    creativeId: r.cr.id,
    name: r.cr.name,
    mediaType: r.cr.type ?? null,
    thumbnailUrl: r.cr.thumbnailKey ? await getSignedDownloadUrl({ folder: 'creatives', key: r.cr.thumbnailKey, expiresInSeconds: 3600 }).catch(() => null) : null,
    client: r.cr.clientId ? { clientId: r.cr.clientId, name: r.clientName ?? '' } : null,
    campaign: r.cr.campaignId ? { campaignId: r.cr.campaignId, name: r.campaignName ?? '' } : null,
    approvalStatus: r.cr.status,
    fileStatus: r.cr.fileStatus,
    adLinkCount: r.adLinkCount,
    archivedAt: r.cr.archivedAt ? r.cr.archivedAt.toISOString() : null,
    createdAt: r.cr.createdAt ? r.cr.createdAt.toISOString() : null,
  })));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ s: sort, k: last.sortKey, i: last.cr.id } satisfies AssetCursor)).toString('base64url') : null };
}

export interface AssetDetail {
  creative: {
    creativeId: string; name: string; mediaType: string | null; contentType: string | null; sizeBytes: number | null; width: number | null; height: number | null;
    durationSeconds: number | null; sha256: string | null; fileStatus: string; approvalStatus: string; section: string; headline: string | null; bodyText: string | null;
    tags: string[]; source: string; clientId: string | null; clientName: string | null; campaignId: string | null; campaignName: string | null;
    archivedAt: string | null; createdAt: string | null; thumbnailUrl: string | null;
  };
  downloadUrl: string | null;
  expiresAt: string | null;
  adLinks: AdLinkDto[];
  landingPage: { id: string; url: string; title: string | null } | null;
  /** The latest API-key calls that touched this asset in the last 90 days, newest first (at most 10). */
  history: Array<{ at: string; tool: string | null; by: string | null; transport: string; result: string }>;
}

/** A signed link (1 hour) to the poster or thumbnail of an asset, or null while none exists. Signed when the answer is made, never stored. */
export async function thumbnailUrlFor(creativeId: string): Promise<string | null> {
  const [r] = await db.select({ key: creatives.thumbnailKey }).from(creatives).where(eq(creatives.id, creativeId));
  return r?.key ? getSignedDownloadUrl({ folder: 'creatives', key: r.key, expiresInSeconds: 3600 }).catch(() => null) : null;
}

/** One asset, a signed download link (default 60 minutes, at most 24 hours) and its ad links. */
export async function getAsset(businessId: string, creativeId: string, downloadUrlMinutes = 60): Promise<AssetDetail> {
  const minutes = Math.min(1440, Math.max(1, Math.floor(downloadUrlMinutes)));
  const [r] = await db
    .select({ cr: creatives, clientName: clients.companyName, campaignName: campaigns.name, lpUrl: landingPages.url, lpTitle: landingPages.title })
    .from(creatives)
    .leftJoin(clients, eq(clients.id, creatives.clientId))
    .leftJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .leftJoin(landingPages, eq(landingPages.id, creatives.landingPageId))
    .where(and(eq(creatives.id, creativeId), eq(creatives.isDeleted, false), creativeInBusiness(businessId)));
  if (!r) throw new ApiError('not_found', 'That asset does not exist.', { hint: 'Use list_assets to find the creativeId.' });
  const cr = r.cr;

  let downloadUrl: string | null = null;
  let expiresAt: string | null = null;
  const loc = resolveR2Location(cr.fileUrl, cr.r2Key);
  // A storage outage must not look like a missing file: if the check itself fails, sign anyway.
  if (loc && (await objectExists(loc.folder, loc.key).catch(() => true))) {
    downloadUrl = await getSignedDownloadUrl({ folder: loc.folder, key: loc.key, expiresInSeconds: minutes * 60 }).catch(() => null);
    if (downloadUrl) expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  }
  const thumbnailUrl = cr.thumbnailKey ? await getSignedDownloadUrl({ folder: 'creatives', key: cr.thumbnailKey, expiresInSeconds: 3600 }).catch(() => null) : null;
  const links = await db.select().from(creativeAdLinks).where(eq(creativeAdLinks.creativeId, cr.id))
    .orderBy(sql`(${creativeAdLinks.status} = 'removed')`, desc(creativeAdLinks.createdAt));

  return {
    creative: {
      creativeId: cr.id, name: cr.name, mediaType: cr.type ?? null, contentType: cr.contentType ?? null, sizeBytes: cr.sizeBytes ?? null,
      width: cr.width ?? null, height: cr.height ?? null, durationSeconds: cr.durationS != null ? Number(cr.durationS) : null, sha256: cr.sha256 ?? null,
      fileStatus: cr.fileStatus, approvalStatus: cr.status, section: cr.section, headline: cr.headline ?? null, bodyText: cr.bodyText ?? null,
      tags: cr.tags, source: cr.source, clientId: cr.clientId ?? null, clientName: r.clientName ?? null, campaignId: cr.campaignId ?? null,
      campaignName: r.campaignName ?? null, archivedAt: cr.archivedAt ? cr.archivedAt.toISOString() : null, createdAt: cr.createdAt ? cr.createdAt.toISOString() : null, thumbnailUrl,
    },
    downloadUrl,
    expiresAt,
    adLinks: links.map(toAdLinkDto),
    landingPage: cr.landingPageId && r.lpUrl ? { id: cr.landingPageId, url: r.lpUrl, title: r.lpTitle ?? null } : null,
    history: await recentHistory(businessId, cr.id),
  };
}

async function recentHistory(businessId: string, creativeId: string): Promise<AssetDetail['history']> {
  const rows = await db.select({ at: apiAuditLog.at, tool: apiAuditLog.tool, agent: apiAuditLog.agent, keyName: apiAuditLog.keyName, transport: apiAuditLog.transport, errorCode: apiAuditLog.errorCode })
    .from(apiAuditLog)
    // The @> is served by the GIN index on records_touched (0057). The 90 days is what the tool promises (get_asset's description), not a cost bound any more.
    .where(and(eq(apiAuditLog.businessId, businessId), sql`${apiAuditLog.at} > now() - interval '90 days'`, sql`${apiAuditLog.recordsTouched} @> ${JSON.stringify([{ type: 'creative', id: creativeId }])}::jsonb`))
    .orderBy(desc(apiAuditLog.at)).limit(10);
  return rows.map((r) => ({ at: r.at.toISOString(), tool: r.tool, by: r.agent ?? r.keyName ?? null, transport: r.transport, result: r.errorCode ?? 'ok' }));
}
