import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages, type LandingPageRow } from '../db/schema/landing-pages.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { AppError, MediaSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isUniqueViolation } from '../utils/pg-errors.js';
import { canonicalizePlatform, normaliseAccountId } from '../utils/catchr-platform.js';
import { normaliseLandingUrl } from '../utils/landing-url.js';
import { fetchRemoteMedia, mediaTypeOf, MAX_MEDIA_BYTES, type RemoteMediaDeps } from '../utils/remote-media.js';
import { uploadFile, getSignedDownloadUrl, objectExists, hashObject, isR2Configured, ObjectTooLargeError, deleteFile } from '../integrations/r2/r2-client.js';
import { resolveR2Location } from './creative.service.js';
import { domainEvents } from './events.js';
import { mediaQueue } from '../jobs/queue.js';

// Creative library (Sam feedback round 1, M2; docs/creative-library-and-api-plan.md).
//
// A creative belongs to a CLIENT and optionally a campaign. client_id NULL
// means "shared on its campaign" — the pre-library rows — and those show under
// every buyer on that campaign (default for Sam's open question 1; flip
// SHARED_SHOWS_UNDER_EVERY_BUYER to file them under nobody instead).
export const SHARED_SHOWS_UNDER_EVERY_BUYER = true;

export type CreativeRow = typeof creatives.$inferSelect;
export type LibraryPlatform = 'meta' | 'taboola' | 'google' | 'tiktok' | 'manual';

export interface UpsertPlatformCreativeInput {
  businessId: string;
  clientId?: string | null;
  campaignId?: string | null;
  platform: LibraryPlatform;
  platformAccountId?: string;
  platformAdId?: string;
  platformCreativeId?: string;
  platformCampaignId?: string;
  platformCampaignName?: string;
  landingPageUrl?: string;
  headline?: string;
  bodyText?: string;
  mediaType: 'image' | 'video';
  sourceUrl?: string;
  r2Key?: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  durationS?: number;
  name?: string;
  /** Internal: who uploaded (JWT callers). */
  uploadedBy?: string | null;
  /** Internal: a file uploaded through create_upload and already verified (size, real file type, SHA-256), up to 4 GB. */
  verified?: { sha256: string; sizeBytes: number; contentType: string; mediaType: 'image' | 'video'; fileStatus?: 'processing' | 'ready' };
}

// ─── Scoping ───

export async function clientInBusiness(clientId: string, businessId: string): Promise<boolean> {
  const [row] = await db.select({ id: clients.id }).from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));
  return Boolean(row);
}

export async function campaignInBusiness(campaignId: string, businessId: string): Promise<boolean> {
  const [row] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), sql`(
      exists (select 1 from ${clients} c where c.id = ${campaigns.clientId} and c.business_id = ${businessId})
      or exists (select 1 from ${clientCampaigns} cc join ${clients} c on c.id = cc.client_id
                 where cc.campaign_id = ${campaigns.id} and c.business_id = ${businessId})
    )`));
  return Boolean(row);
}

/**
 * A campaign a business may file under: one of its own, or a shared campaign that no client buys yet (spec v1.0 section 2.1:
 * "linked to that client, or a shared campaign with no client"). "Shared" here means no client of any business buys it
 * (campaigns has no business column), so a campaign bought by another business's client is still refused.
 * The shared branch needs the creative's resulting clientId: a creative with no client belongs to a business only through
 * its campaign's buyers, so on an unbought campaign it would belong to nobody and then to whoever buys it first.
 * Ownership of an existing creative still uses the stricter campaignInBusiness.
 */
export async function campaignUsableBy(campaignId: string, businessId: string, resultingClientId: string | null): Promise<boolean> {
  if (await campaignInBusiness(campaignId, businessId)) return true;
  if (!resultingClientId) return false;
  const [row] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.clientId), sql`not exists (select 1 from ${clientCampaigns} cc where cc.campaign_id = ${campaigns.id})`));
  return Boolean(row);
}

/** SQL predicate: this creative row belongs to the business. */
export function creativeInBusiness(businessId: string): SQL {
  return sql`(
    exists (select 1 from ${clients} c where c.id = ${creatives.clientId} and c.business_id = ${businessId})
    or (${creatives.clientId} is null and ${creatives.campaignId} is not null and (
      exists (select 1 from ${campaigns} k join ${clients} c on c.id = k.client_id
              where k.id = ${creatives.campaignId} and c.business_id = ${businessId})
      or exists (select 1 from ${clientCampaigns} cc join ${clients} c on c.id = cc.client_id
                 where cc.campaign_id = ${creatives.campaignId} and c.business_id = ${businessId})
    ))
  )`;
}

export async function creativeBelongsToBusiness(row: Pick<CreativeRow, 'clientId' | 'campaignId'>, businessId: string): Promise<boolean> {
  if (row.clientId) return clientInBusiness(row.clientId, businessId);
  if (row.campaignId) return campaignInBusiness(row.campaignId, businessId);
  return false;
}

/**
 * Ad account → client, matched on (platform, account id) only — never the
 * account name (some Taboola names don't match their ids). Uses the same
 * canonical platform strings as client_ad_accounts (migration 0041).
 */
export async function resolveClientForAdAccount(
  businessId: string, platform: string, accountId: string,
): Promise<{ clientId: string; campaignId: string | null } | null> {
  const p = canonicalizePlatform(platform) ?? platform.toLowerCase().trim();
  const [row] = await db
    .select({ clientId: clientAdAccounts.clientId, campaignId: clientAdAccounts.campaignId })
    .from(clientAdAccounts)
    .where(and(eq(clientAdAccounts.businessId, businessId), eq(clientAdAccounts.platform, p), eq(clientAdAccounts.accountId, normaliseAccountId(platform, accountId))));
  return row ?? null;
}

// ─── Landing pages ───

export interface LandingPageDto {
  id: string;
  clientId: string | null;
  campaignId: string | null;
  url: string;
  normalisedUrl: string | null;
  title: string | null;
  status: string;
  creativeCount?: number;
  /** Same as creativeCount — the name the admin screens read. */
  creativesCount?: number;
  clientName?: string | null;
  createdAt: string | null;
}

function lpDto(row: LandingPageRow, creativeCount?: number, clientName?: string | null): LandingPageDto {
  return {
    id: row.id,
    clientId: row.clientId ?? null,
    campaignId: row.campaignId ?? null,
    url: row.url,
    normalisedUrl: row.normalisedUrl ?? null,
    title: row.title ?? null,
    status: row.status ?? 'active',
    ...(creativeCount !== undefined ? { creativeCount, creativesCount: creativeCount } : {}),
    ...(clientName !== undefined ? { clientName } : {}),
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

function checkUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 500) throw new AppError(422, 'Landing page URL is required (max 500 characters)');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new AppError(422, `"${trimmed}" is not a valid web address`);
  }
  return withScheme;
}

/** Find-or-create the client's landing page for this URL (normalised). */
export async function ensureLandingPage(
  clientId: string, url: string, opts: { title?: string | null; campaignId?: string | null } = {},
): Promise<{ page: LandingPageRow; created: boolean }> {
  const clean = checkUrl(url);
  const normalised = normaliseLandingUrl(clean);
  const [existing] = await db.select().from(landingPages)
    .where(and(eq(landingPages.clientId, clientId), eq(landingPages.normalisedUrl, normalised)));
  if (existing) {
    if (existing.status === 'archived') {
      const [revived] = await db.update(landingPages).set({ status: 'active', updatedAt: new Date() })
        .where(eq(landingPages.id, existing.id)).returning();
      return { page: revived!, created: false };
    }
    return { page: existing, created: false };
  }
  try {
    const [row] = await db.insert(landingPages).values({
      clientId, campaignId: opts.campaignId ?? null, url: clean, normalisedUrl: normalised, title: opts.title ?? null,
    }).returning();
    return { page: row!, created: true };
  } catch (err) {
    // Two concurrent creates for the same page: the unique index wins, re-read.
    const [again] = await db.select().from(landingPages)
      .where(and(eq(landingPages.clientId, clientId), eq(landingPages.normalisedUrl, normalised)));
    if (again) return { page: again, created: false };
    throw err;
  }
}

export async function listLandingPages(
  businessId: string, filters: { clientId?: string; campaignId?: string; q?: string; includeArchived?: boolean } = {},
): Promise<LandingPageDto[]> {
  const where: SQL[] = [sql`exists (select 1 from ${clients} c where c.id = ${landingPages.clientId} and c.business_id = ${businessId})`];
  if (filters.clientId) where.push(eq(landingPages.clientId, filters.clientId));
  if (filters.campaignId) where.push(eq(landingPages.campaignId, filters.campaignId));
  if (!filters.includeArchived) where.push(sql`coalesce(${landingPages.status}, 'active') <> 'archived'`);
  if (filters.q) where.push(or(ilike(landingPages.url, `%${filters.q}%`), ilike(landingPages.title, `%${filters.q}%`))!);
  const rows = await db
    .select({
      lp: landingPages,
      // Qualified by hand: drizzle renders a column inside a select-field
      // subquery unqualified ("id"), which would bind to creatives.id.
      n: sql<number>`(select count(*)::int from creatives cr where cr.landing_page_id = "landing_pages"."id" and cr.is_deleted = false)`,
      clientName: sql<string | null>`(select c2.company_name from clients c2 where c2.id = "landing_pages"."client_id")`,
    })
    .from(landingPages)
    .where(and(...where))
    .orderBy(desc(landingPages.createdAt));
  return rows.map((r) => lpDto(r.lp, r.n, r.clientName));
}

export async function createLandingPage(
  businessId: string, input: { clientId: string; url: string; title?: string | null; campaignId?: string | null },
): Promise<{ page: LandingPageDto; created: boolean }> {
  if (!(await clientInBusiness(input.clientId, businessId))) throw new AppError(404, 'Client not found');
  if (input.campaignId && !(await campaignUsableBy(input.campaignId, businessId, input.clientId))) throw new AppError(404, 'Campaign not found');
  const { page, created } = await ensureLandingPage(input.clientId, input.url, { title: input.title, campaignId: input.campaignId });
  if (!created && input.title && !page.title) {
    const [row] = await db.update(landingPages).set({ title: input.title, updatedAt: new Date() }).where(eq(landingPages.id, page.id)).returning();
    return { page: lpDto(row!), created };
  }
  return { page: lpDto(page), created };
}

async function loadLandingPage(businessId: string, id: string): Promise<LandingPageRow> {
  const [row] = await db.select().from(landingPages).where(eq(landingPages.id, id));
  if (!row || !row.clientId || !(await clientInBusiness(row.clientId, businessId))) throw new AppError(404, 'Landing page not found');
  return row;
}

export async function updateLandingPage(
  businessId: string, id: string, patch: { url?: string; title?: string | null; status?: 'active' | 'archived' },
): Promise<LandingPageDto> {
  const row = await loadLandingPage(businessId, id);
  const set: Partial<typeof landingPages.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.status) set.status = patch.status;
  if (patch.url !== undefined) {
    const clean = checkUrl(patch.url);
    const normalised = normaliseLandingUrl(clean);
    const [clash] = await db.select({ id: landingPages.id }).from(landingPages)
      .where(and(eq(landingPages.clientId, row.clientId!), eq(landingPages.normalisedUrl, normalised)));
    if (clash && clash.id !== id) throw new AppError(409, 'This client already has a landing page with that address');
    set.url = clean;
    set.normalisedUrl = normalised;
  }
  const [updated] = await db.update(landingPages).set(set).where(eq(landingPages.id, id)).returning();
  return lpDto(updated!);
}

/** Soft delete: archived pages drop out of lists; creatives keep their link. */
export async function archiveLandingPage(businessId: string, id: string): Promise<void> {
  await loadLandingPage(businessId, id);
  await db.update(landingPages).set({ status: 'archived', updatedAt: new Date() }).where(eq(landingPages.id, id));
}

// ─── Creatives ───

export interface LibraryCreativeDto {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** True when client_id is NULL — shared by every buyer on the campaign. */
  shared: boolean;
  platform: string | null;
  platformAccountId: string | null;
  platformAdId: string | null;
  platformCreativeId: string | null;
  platformCampaignId: string | null;
  platformCampaignName: string | null;
  landingPage: { id: string; url: string; title: string | null } | null;
  landingPageId: string | null;
  landingPageUrl: string | null;
  /** Fresh signed link (1 h); never stored. */
  fileUrl: string | null;
  headline: string | null;
  bodyText: string | null;
  mediaType: string;
  contentType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  sha256: string | null;
  status: string;
  section: string;
  thumbnailUrl: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  createdAt: string | null;
}

interface JoinedRow {
  cr: CreativeRow;
  clientName: string | null;
  campaignName: string | null;
  lpUrl: string | null;
  lpTitle: string | null;
}

async function toLibraryDto(r: JoinedRow): Promise<LibraryCreativeDto> {
  const { cr } = r;
  let thumbnailUrl: string | null = null;
  if (cr.thumbnailKey) {
    thumbnailUrl = await getSignedDownloadUrl({ folder: 'creatives', key: cr.thumbnailKey, expiresInSeconds: 3600 }).catch(() => null);
  }
  // Fresh signed link per row (never stored — N8) so the library grid can
  // preview images that have no server thumbnail yet. Signing is local.
  // Retest R3 / R2-1: this used to sign folder 'creatives' + r2Key for EVERY row. Uploads from before the
  // library landed in 'misc/' (the stored file_url says so), so those rows signed a key that does not exist
  // and answered NoSuchKey — the files were never missing. Resolve the folder from the row, as the detail,
  // portal and download paths already do.
  const loc = resolveR2Location(cr.fileUrl, cr.r2Key);
  const fileUrl = loc
    ? await getSignedDownloadUrl({ folder: loc.folder, key: loc.key, expiresInSeconds: 3600 }).catch(() => null)
    : null;
  return {
    id: cr.id,
    name: cr.name,
    clientId: cr.clientId ?? null,
    clientName: r.clientName,
    campaignId: cr.campaignId ?? null,
    campaignName: r.campaignName,
    shared: !cr.clientId,
    platform: cr.platform ?? null,
    platformAccountId: cr.platformAccountId ?? null,
    platformAdId: cr.platformAdId ?? null,
    platformCreativeId: cr.platformCreativeId ?? null,
    platformCampaignId: cr.platformCampaignId ?? null,
    platformCampaignName: cr.platformCampaignName ?? null,
    landingPage: cr.landingPageId && r.lpUrl ? { id: cr.landingPageId, url: r.lpUrl, title: r.lpTitle } : null,
    landingPageId: cr.landingPageId ?? null,
    landingPageUrl: r.lpUrl ?? null,
    headline: cr.headline ?? null,
    bodyText: cr.bodyText ?? null,
    mediaType: cr.type ?? 'image',
    contentType: cr.contentType ?? null,
    sizeBytes: cr.sizeBytes ?? null,
    width: cr.width ?? null,
    height: cr.height ?? null,
    durationS: cr.durationS != null ? Number(cr.durationS) : null,
    sha256: cr.sha256 ?? null,
    status: cr.status,
    section: cr.section,
    thumbnailUrl,
    fileUrl,
    firstSeen: cr.firstSeen ? cr.firstSeen.toISOString() : null,
    lastSeen: cr.lastSeen ? cr.lastSeen.toISOString() : null,
    createdAt: cr.createdAt ? cr.createdAt.toISOString() : null,
  };
}

function joinedSelect() {
  return db
    .select({
      cr: creatives,
      clientName: clients.companyName,
      campaignName: campaigns.name,
      lpUrl: landingPages.url,
      lpTitle: landingPages.title,
    })
    .from(creatives)
    .leftJoin(clients, eq(clients.id, creatives.clientId))
    .leftJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .leftJoin(landingPages, eq(landingPages.id, creatives.landingPageId));
}

export interface ListCreativesFilters {
  clientId?: string;
  platform?: string;
  campaignId?: string;
  landingPageId?: string;
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  /** Archived assets are hidden unless this is true. */
  includeArchived?: boolean;
  sort?: 'created' | 'last_seen' | 'name';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export async function listCreatives(businessId: string, f: ListCreativesFilters = {}) {
  const where: SQL[] = [eq(creatives.isDeleted, false), creativeInBusiness(businessId)];
  if (!f.includeArchived) where.push(isNull(creatives.archivedAt));
  if (f.clientId) {
    where.push(SHARED_SHOWS_UNDER_EVERY_BUYER
      ? or(
          eq(creatives.clientId, f.clientId),
          and(isNull(creatives.clientId), sql`${creatives.campaignId} in (select cc.campaign_id from ${clientCampaigns} cc where cc.client_id = ${f.clientId})`),
        )!
      : eq(creatives.clientId, f.clientId));
  }
  if (f.platform) where.push(eq(creatives.platform, f.platform));
  if (f.campaignId) where.push(eq(creatives.campaignId, f.campaignId));
  if (f.landingPageId) where.push(eq(creatives.landingPageId, f.landingPageId));
  if (f.status) where.push(sql`${creatives.status}::text = ${f.status}`);
  if (f.from) where.push(sql`${creatives.createdAt} >= ${f.from}::date`);
  if (f.to) where.push(sql`${creatives.createdAt} < (${f.to}::date + interval '1 day')`);
  if (f.q) {
    const like = `%${f.q}%`;
    where.push(or(
      ilike(creatives.name, like), ilike(creatives.headline, like), ilike(creatives.bodyText, like),
      ilike(creatives.platformAdId, like), ilike(creatives.platformCreativeId, like), ilike(creatives.platformCampaignName, like),
    )!);
  }
  const page = Math.max(1, f.page ?? 1);
  const limit = Math.min(100, Math.max(1, f.limit ?? 24));
  const dir = f.order === 'asc' ? asc : desc;
  // Qualified by hand — clients/campaigns/landing_pages all have created_at.
  const orderCol = f.sort === 'name' ? creatives.name : f.sort === 'last_seen' ? sql`coalesce("creatives"."last_seen", "creatives"."created_at")` : creatives.createdAt;

  const [rows, [countRow]] = await Promise.all([
    joinedSelect().where(and(...where)).orderBy(dir(orderCol as never), desc(creatives.id)).limit(limit).offset((page - 1) * limit),
    db.select({ n: sql<number>`count(*)::int` }).from(creatives).where(and(...where)),
  ]);
  return { creatives: await Promise.all(rows.map(toLibraryDto)), total: countRow?.n ?? 0, page, pageSize: limit };
}

export async function getCreative(businessId: string, id: string): Promise<LibraryCreativeDto | null> {
  const [row] = await joinedSelect().where(and(eq(creatives.id, id), eq(creatives.isDeleted, false), creativeInBusiness(businessId)));
  return row ? toLibraryDto(row) : null;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'creative';
}

function extFor(contentType: string): string {
  const sub = contentType.split('/')[1]?.split(';')[0] ?? 'bin';
  return ({ jpeg: 'jpg', 'quicktime': 'mov' } as Record<string, string>)[sub] ?? sub.replace(/[^a-z0-9]/gi, '');
}

/**
 * Stable, non-expiring pointer to an object in the creatives folder (never a
 * presigned URL — those expire; see N8). parseR2LocationFromFileUrl() finds
 * the folder segment in the path, so signed URLs are minted from it on read.
 */
export function r2Ref(key: string): string {
  return `r2://stato/creatives/${key.replace(/^\/+/, '')}`;
}

function enqueueThumbnail(creativeId: string): void {
  mediaQueue?.add('thumbnail', { creativeId }, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 500, removeOnFail: 500 })
    .catch((err: unknown) => logger.warn({ err, creativeId }, 'Could not queue creative thumbnail'));
}

/**
 * Create or update a creative from a platform ad (Meta/Taboola sync, public
 * API) or a manual upload. Idempotent: the same (platform, platformCreativeId)
 * — or, without one, the same file (sha256) for the same client — updates the
 * existing row instead of adding a copy.
 */
export async function upsertPlatformCreative(
  input: UpsertPlatformCreativeInput, deps: RemoteMediaDeps = {},
): Promise<{ creative: CreativeRow; created: boolean }> {
  const { businessId } = input;
  let clientId = input.clientId ?? null;
  let campaignId = input.campaignId ?? null;

  if (!clientId && input.platformAccountId && input.platform !== 'manual') {
    const hit = await resolveClientForAdAccount(businessId, input.platform, input.platformAccountId);
    if (hit) {
      clientId = hit.clientId;
      campaignId = campaignId ?? hit.campaignId;
    }
  }
  if (clientId && !(await clientInBusiness(clientId, businessId))) throw new AppError(404, 'Client not found');
  if (campaignId && !(await campaignUsableBy(campaignId, businessId, clientId))) throw new AppError(404, 'Campaign not found');
  if (!clientId && !campaignId) {
    throw new AppError(422, input.platformAccountId
      ? `No client is linked to ${input.platform} ad account ${input.platformAccountId}. Link it on the "Link ad accounts" screen first, or send clientId.`
      : 'clientId (or a linked platformAccountId) is required');
  }

  // Existing row?
  let existing: CreativeRow | undefined;
  if (input.platformCreativeId) {
    [existing] = await db.select().from(creatives)
      .where(and(eq(creatives.platform, input.platform), eq(creatives.platformCreativeId, input.platformCreativeId)));
    if (existing && !(await creativeBelongsToBusiness(existing, businessId))) {
      throw new AppError(409, 'This platform creative id is already registered to another business');
    }
  }
  // With an r2Key the server hashes the stored object below and dedupes on
  // that instead of the client-supplied hash.
  if (!existing && input.sha256 && clientId && !input.r2Key) {
    [existing] = await db.select().from(creatives)
      .where(and(eq(creatives.sha256, input.sha256.toLowerCase()), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
  }

  // Media: an r2Key from the presign flow, else download sourceUrl (only when
  // this is new, or the caller sent a different file).
  let r2Key = input.r2Key ?? null;
  let fileUrl: string | null = null;
  let contentType = input.contentType ?? null;
  let sizeBytes = input.sizeBytes ?? null;
  let sha256 = input.sha256?.toLowerCase() ?? null;
  let mediaType = input.mediaType;

  if (r2Key && input.verified) {
    // Already checked by complete_upload: the real size, file type and SHA-256 of the stored object.
    sha256 = input.verified.sha256;
    sizeBytes = input.verified.sizeBytes;
    contentType = input.verified.contentType;
    mediaType = input.verified.mediaType;
    const holders = await db.select().from(creatives).where(eq(creatives.r2Key, r2Key));
    for (const holder of holders) {
      if (!(await creativeBelongsToBusiness(holder, businessId))) throw new AppError(409, 'This file is already registered to another business');
    }
    if (!existing && clientId) {
      [existing] = await db.select().from(creatives)
        .where(and(eq(creatives.sha256, sha256), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
      // Identical bytes are already on file: keep that file and remove the duplicate upload.
      if (existing?.r2Key && existing.r2Key !== r2Key) {
        if (holders.length === 0) {
          deleteFile('creatives', r2Key).catch((err: unknown) => logger.warn({ err, r2Key }, 'Could not delete duplicate creative upload'));
        }
        r2Key = existing.r2Key;
      }
    }
    fileUrl = r2Ref(r2Key);
  } else if (r2Key) {
    if (contentType && !mediaTypeOf(contentType)) throw new MediaSourceError(422, 'Creatives must be images or videos', 'unsupported_type');
    if (sizeBytes && sizeBytes > MAX_MEDIA_BYTES) throw new AppError(413, 'File too large: max 50 MB');
    // Presigned keys are not bound to a business, so a key already held by
    // another business's creative must never be registered again here — that
    // would hand out a signed download URL for someone else's file.
    const holders = await db.select().from(creatives).where(eq(creatives.r2Key, r2Key));
    for (const holder of holders) {
      if (!(await creativeBelongsToBusiness(holder, businessId))) {
        throw new AppError(409, 'This file is already registered to another business');
      }
    }
    if (existing?.r2Key === r2Key && existing.sha256) {
      // Same file re-registered (idempotent retry, metadata edit): already verified.
      sha256 = existing.sha256;
      sizeBytes = existing.sizeBytes ?? sizeBytes;
    } else {
      // Read the stored object ourselves: the browser's hash, size and type are hints, not proof.
      let stored: Awaited<ReturnType<typeof hashObject>>;
      try {
        stored = await hashObject('creatives', r2Key, MAX_MEDIA_BYTES);
      } catch (err) {
        if (err instanceof ObjectTooLargeError) throw new AppError(413, 'File too large: max 50 MB');
        logger.error({ err, r2Key }, 'Could not read uploaded creative from storage');
        throw new AppError(502, "Couldn't check the uploaded file right now, so nothing was saved. Please try again in a few minutes.");
      }
      if (stored) {
        if (sha256 && sha256 !== stored.sha256) throw new AppError(422, 'sha256 does not match the uploaded file');
        sha256 = stored.sha256;
        sizeBytes = stored.sizeBytes;
        if (stored.contentType && mediaTypeOf(stored.contentType)) contentType = stored.contentType;
        if (!existing && clientId) {
          [existing] = await db.select().from(creatives)
            .where(and(eq(creatives.sha256, stored.sha256), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
          // Identical bytes are already on file: keep that file, don't swap in
          // the duplicate upload (which would orphan the old object).
          if (existing?.r2Key && existing.r2Key !== r2Key) {
            // The duplicate object was just uploaded and nothing references it: remove it.
            if (holders.length === 0) {
              deleteFile('creatives', r2Key).catch((err: unknown) => logger.warn({ err, r2Key }, 'Could not delete duplicate creative upload'));
            }
            r2Key = existing.r2Key;
          }
        }
      } else if (isR2Configured()) {
        throw new AppError(422, 'That file was not found in storage. Upload it with POST /uploads/presign first.');
      } else if (!existing && sha256 && clientId) {
        // Mock storage (dev/test) can't be read back: fall back to the hint.
        [existing] = await db.select().from(creatives)
          .where(and(eq(creatives.sha256, sha256.toLowerCase()), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
      }
    }
    fileUrl = r2Ref(r2Key);
  } else if (input.sourceUrl && !existing?.r2Key) {
    const media = await fetchRemoteMedia(input.sourceUrl, deps);
    if (!existing && clientId) {
      // Same bytes already on file for this client → that's the creative.
      [existing] = await db.select().from(creatives)
        .where(and(eq(creatives.sha256, media.sha256), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
    }
    if (!existing || !existing.r2Key) {
      const key = `${Date.now()}-${safeName(input.name ?? input.platformCreativeId ?? 'creative')}.${extFor(media.contentType)}`;
      // Storage down (R2 outage, bad credentials) used to surface as a bare 500
      // "Internal server error". Say what failed and that nothing was saved.
      let up: Awaited<ReturnType<typeof uploadFile>>;
      try {
        up = await uploadFile({ folder: 'creatives', key, body: media.buffer, contentType: media.contentType });
      } catch (err) {
        logger.error({ err, key }, 'Creative upload to storage failed');
        throw new AppError(502, "Couldn't store the file right now, so nothing was saved. Please try again in a few minutes.");
      }
      r2Key = key;
      fileUrl = up.publicUrl;
    }
    contentType = media.contentType;
    sizeBytes = media.sizeBytes;
    sha256 = media.sha256;
    mediaType = media.mediaType;
  } else if (!existing) {
    throw new AppError(422, 'Send the file: either r2Key (from POST /uploads/presign) or sourceUrl');
  }

  let landingPageId: string | null | undefined;
  if (input.landingPageUrl && clientId) {
    landingPageId = (await ensureLandingPage(clientId, input.landingPageUrl, { campaignId })).page.id;
  }

  const now = new Date();
  const fields = {
    clientId,
    campaignId,
    platform: input.platform,
    platformAccountId: input.platformAccountId ? normaliseAccountId(input.platform, input.platformAccountId) : null,
    platformAdId: input.platformAdId ?? null,
    platformCreativeId: input.platformCreativeId ?? null,
    platformCampaignId: input.platformCampaignId ?? null,
    platformCampaignName: input.platformCampaignName ?? null,
    headline: input.headline ?? null,
    bodyText: input.bodyText ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationS: input.durationS != null ? String(input.durationS) : null,
  };

  if (existing) {
    // Only overwrite what the caller actually sent — a sync that lacks a
    // headline must not blank one an operator typed in.
    const patch: Partial<typeof creatives.$inferInsert> = { lastSeen: now, updatedAt: now };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    if (landingPageId) patch.landingPageId = landingPageId;
    if (r2Key && r2Key !== existing.r2Key) {
      Object.assign(patch, { r2Key, fileUrl: fileUrl ?? existing.fileUrl, contentType, sizeBytes, sha256, type: mediaType, thumbnailKey: null });
    }
    if (input.name) patch.name = input.name;
    const [row] = await db.update(creatives).set(patch).where(eq(creatives.id, existing.id)).returning();
    const changed = Object.keys(patch).some((k) => !['lastSeen', 'updatedAt'].includes(k));
    if (changed) domainEvents.emit('creative.changed', { businessId, data: { creativeId: row!.id, clientId: row!.clientId, platform: row!.platform } });
    if (patch.r2Key) enqueueThumbnail(row!.id);
    return { creative: row!, created: false };
  }

  let row: CreativeRow | undefined;
  try {
    [row] = await db.insert(creatives).values({
      ...fields,
      name: input.name ?? input.headline ?? input.platformCreativeId ?? 'Creative',
      fileUrl: fileUrl ?? r2Ref(r2Key!),
      r2Key,
      contentType,
      sizeBytes,
      sha256,
      type: mediaType,
      section: 'media',
      fileStatus: input.verified?.fileStatus ?? 'ready',
      landingPageId: landingPageId ?? null,
      uploadedBy: input.uploadedBy ?? null,
      firstSeen: now,
      lastSeen: now,
    }).returning();
  } catch (err) {
    // The unique index on (client, file hash) refused a second live creative for the same file: a request for the same file
    // got there first. Return that one as a duplicate instead of failing.
    if (!isUniqueViolation(err) || !sha256 || !clientId) throw err;
    const [winner] = await db.select().from(creatives).where(and(eq(creatives.sha256, sha256), eq(creatives.clientId, clientId), eq(creatives.isDeleted, false)));
    if (!winner) throw err;
    logger.warn({ creativeId: winner.id, clientId }, 'A second creative for the same file was refused by the unique index; returning the existing one');
    return { creative: winner, created: false };
  }
  logger.info({ creativeId: row!.id, clientId, platform: input.platform }, 'Creative added to library');
  domainEvents.emit('creative.added', { businessId, data: { creativeId: row!.id, clientId, campaignId, platform: input.platform, platformCreativeId: input.platformCreativeId ?? null } });
  enqueueThumbnail(row!.id);
  return { creative: row!, created: true };
}

async function loadCreative(businessId: string, id: string): Promise<CreativeRow> {
  const [row] = await db.select().from(creatives).where(and(eq(creatives.id, id), eq(creatives.isDeleted, false)));
  if (!row || !(await creativeBelongsToBusiness(row, businessId))) throw new AppError(404, 'Creative not found');
  return row;
}

export async function attachLandingPage(
  businessId: string, creativeId: string, target: { url?: string; landingPageId?: string },
): Promise<LibraryCreativeDto> {
  const row = await loadCreative(businessId, creativeId);
  let lpId: string;
  if (target.landingPageId) {
    const lp = await loadLandingPage(businessId, target.landingPageId);
    if (row.clientId && lp.clientId !== row.clientId) throw new AppError(422, 'That landing page belongs to a different client');
    lpId = lp.id;
  } else if (target.url) {
    if (!row.clientId) throw new AppError(422, 'Assign this creative to a client before adding a landing page URL');
    lpId = (await ensureLandingPage(row.clientId, target.url, { campaignId: row.campaignId })).page.id;
  } else {
    throw new AppError(422, 'Send url or landingPageId');
  }
  await db.update(creatives).set({ landingPageId: lpId, updatedAt: new Date() }).where(eq(creatives.id, row.id));
  domainEvents.emit('creative.changed', { businessId, data: { creativeId: row.id, clientId: row.clientId, landingPageId: lpId } });
  return (await getCreative(businessId, row.id))!;
}

export async function updateCreative(
  businessId: string, id: string,
  patch: { clientId?: string | null; campaignId?: string | null; landingPageId?: string | null; name?: string; headline?: string | null; bodyText?: string | null },
): Promise<LibraryCreativeDto> {
  const row = await loadCreative(businessId, id);
  const set: Partial<typeof creatives.$inferInsert> = { updatedAt: new Date() };
  const nextClient = patch.clientId !== undefined ? patch.clientId : row.clientId;
  const nextCampaign = patch.campaignId !== undefined ? patch.campaignId : row.campaignId;
  if (patch.clientId !== undefined) {
    if (patch.clientId && !(await clientInBusiness(patch.clientId, businessId))) throw new AppError(404, 'Client not found');
    set.clientId = patch.clientId;
  }
  if (patch.campaignId !== undefined) {
    if (patch.campaignId && !(await campaignUsableBy(patch.campaignId, businessId, nextClient ?? null))) throw new AppError(404, 'Campaign not found');
    set.campaignId = patch.campaignId;
  } else if (patch.clientId !== undefined && !nextClient && nextCampaign && !(await campaignInBusiness(nextCampaign, businessId))) {
    // Dropping the client leaves only the campaign to say whose it is; a shared one says nothing.
    throw new AppError(422, 'A shared campaign needs a client');
  }
  if (!nextClient && !nextCampaign) throw new AppError(422, 'A creative needs a client or a campaign');
  if (patch.landingPageId !== undefined) {
    if (patch.landingPageId) {
      const lp = await loadLandingPage(businessId, patch.landingPageId);
      if (nextClient && lp.clientId !== nextClient) throw new AppError(422, 'That landing page belongs to a different client');
    }
    set.landingPageId = patch.landingPageId;
  } else if (patch.clientId !== undefined && row.landingPageId) {
    // Moving to another client: the old client's landing page no longer fits.
    const [lp] = await db.select({ clientId: landingPages.clientId }).from(landingPages).where(eq(landingPages.id, row.landingPageId));
    if (lp && lp.clientId !== nextClient) set.landingPageId = null;
  }
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.headline !== undefined) set.headline = patch.headline;
  if (patch.bodyText !== undefined) set.bodyText = patch.bodyText;
  await db.update(creatives).set(set).where(eq(creatives.id, id));
  domainEvents.emit('creative.changed', { businessId, data: { creativeId: id, clientId: nextClient } });
  return (await getCreative(businessId, id))!;
}

export type BulkAction =
  | { action: 'assign_landing_page'; ids: string[]; landingPageId?: string; url?: string }
  | { action: 'move_client'; ids: string[]; clientId: string }
  | { action: 'submit_for_approval'; ids: string[] };

export interface BulkResult { ok: string[]; failed: Array<{ id: string; message: string }> }

export async function bulkUpdate(
  businessId: string, body: BulkAction,
  submit: (creativeId: string) => Promise<unknown>,
): Promise<BulkResult> {
  const out: BulkResult = { ok: [], failed: [] };
  for (const id of [...new Set(body.ids)]) {
    try {
      if (body.action === 'assign_landing_page') await attachLandingPage(businessId, id, { landingPageId: body.landingPageId, url: body.url });
      else if (body.action === 'move_client') await updateCreative(businessId, id, { clientId: body.clientId });
      else {
        await loadCreative(businessId, id);
        await submit(id);
      }
      out.ok.push(id);
    } catch (err) {
      out.failed.push({ id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Signed URL for a library creative's file (image/video) — 1 hour.
 *
 * `missing` is true when the row points at a stored file that is not in
 * storage any more (retest R2-1: 3 rows signed fine but every open returned
 * R2's NoSuchKey XML). Signing is local and never notices, so HEAD first and
 * let the caller say "file missing" instead of handing out a dead link.
 */
export async function signedFile(businessId: string, id: string): Promise<{ url: string | null; missing: boolean }> {
  const row = await loadCreative(businessId, id).catch(() => null);
  if (!row) return { url: null, missing: false };
  const loc = resolveR2Location(row.fileUrl, row.r2Key);
  if (!loc) return { url: null, missing: false };
  // A storage outage must not look like a missing file: if the check itself fails, sign the link as before.
  if (!(await objectExists(loc.folder, loc.key).catch(() => true))) return { url: null, missing: true };
  return { url: await getSignedDownloadUrl({ folder: loc.folder, key: loc.key, expiresInSeconds: 3600 }), missing: false };
}

export async function signedFileUrl(businessId: string, id: string): Promise<string | null> {
  return (await signedFile(businessId, id)).url;
}

export async function creativesByIds(ids: string[]): Promise<CreativeRow[]> {
  if (!ids.length) return [];
  return db.select().from(creatives).where(inArray(creatives.id, ids));
}
