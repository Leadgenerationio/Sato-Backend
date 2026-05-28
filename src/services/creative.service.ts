import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clients } from '../db/schema/clients.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { logger } from '../utils/logger.js';
import { uuidOrNull } from '../utils/zod-helpers.js';
import { resolveSatoCampaignId } from '../utils/resolve-campaign-id.js';
import { notifyBuyersOfNewCreative } from './creative-review-email.service.js';
import { getSignedDownloadUrl, parseR2LocationFromFileUrl } from '../integrations/r2/r2-client.js';
import type { R2Folder } from '../integrations/r2/r2-types.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Verify a campaign belongs to a client owned by the requester's business.
 *
 * Two ownership paths:
 *   1. Legacy direct link — campaigns.client_id points to a client in
 *      the requester's business. This was the only path before Slice 2.
 *   2. Slice 2 junction — at least one client_campaigns row links this
 *      campaign to a client in the requester's business. LeadByte-auto-
 *      inserted campaigns (Piece 1) have campaigns.client_id = NULL, so
 *      they're ONLY reachable via path #2.
 *
 * Without path #2, creative upload + listing returned "Campaign not
 * found" for every vertical-level campaign (INSULATION, etc.) — Sam
 * couldn't upload assets against any LeadByte-synced campaign.
 */
async function campaignBelongsToBusiness(campaignId: string, businessId: string): Promise<boolean> {
  // Path 1: direct client_id.
  const [direct] = await db
    .select({ businessId: clients.businessId })
    .from(campaigns)
    .innerJoin(clients, eq(campaigns.clientId, clients.id))
    .where(eq(campaigns.id, campaignId));
  if (direct?.businessId === businessId) return true;

  // Path 2: any linked buyer via client_campaigns is in the requester's business.
  const [linked] = await db
    .select({ businessId: clients.businessId })
    .from(clientCampaigns)
    .innerJoin(clients, eq(clientCampaigns.clientId, clients.id))
    .where(and(eq(clientCampaigns.campaignId, campaignId), eq(clients.businessId, businessId)))
    .limit(1);
  return Boolean(linked);
}

export interface CreativeDto {
  id: string;
  campaignId: string;
  name: string;
  type: 'image' | 'video' | 'text' | string;
  fileUrl: string;
  r2Key: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  version: number;
  uploadedAt: string;
  section: 'media' | 'copy_lp';
  // T2: lifecycle state + when staff first sent it to the buyer.
  status: 'draft' | 'sent_for_approval' | 'approved' | 'rejected' | 'changes_requested';
  submittedAt: string | null;
}

type CreativeRow = typeof creatives.$inferSelect;

function toDto(row: CreativeRow): CreativeDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    type: row.type ?? 'image',
    fileUrl: row.fileUrl,
    r2Key: row.r2Key ?? null,
    sizeBytes: row.sizeBytes ?? null,
    contentType: row.contentType ?? null,
    version: row.version ?? 1,
    uploadedAt: (row.createdAt ?? new Date()).toISOString(),
    section: (row.section as 'media' | 'copy_lp') ?? 'media',
    status: row.status,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
  };
}

/**
 * List creatives for a campaign, scoped to the requester's business.
 * Soft-deleted rows are filtered out.
 */
export async function listCreativesForCampaign(
  campaignId: string,
  requester: AuthPayload,
): Promise<CreativeDto[]> {
  const businessId = requester.businessId;
  if (!businessId) return [];

  // FE passes either the Sato UUID or LeadByte's numeric campaign id ("38").
  // Resolve to Sato UUID first so the DB query has a valid FK to match.
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return [];

  if (!(await campaignBelongsToBusiness(satoId, businessId))) return [];

  const rows = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.campaignId, satoId), eq(creatives.isDeleted, false)));
  return rows.map(toDto);
}

export interface CreateCreativeInput {
  campaignId: string;
  name: string;
  type: 'image' | 'video' | 'text';
  r2Key: string;
  fileUrl: string;
  sizeBytes: number;
  contentType: string;
  // Buyer-review section (Sam #9/#11). Defaults to 'media' server-side
  // if the caller omits — preserves backwards compat with the upload
  // flow before the v2 review feature shipped.
  section?: 'media' | 'copy_lp';
}

export async function createCreative(
  input: CreateCreativeInput,
  requester: AuthPayload,
): Promise<CreativeDto | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  // FE may pass either Sato uuid or LeadByte numeric id — resolve first.
  const satoId = await resolveSatoCampaignId(input.campaignId);
  if (!satoId) return null;

  if (!(await campaignBelongsToBusiness(satoId, businessId))) return null;

  const [row] = await db
    .insert(creatives)
    .values({
      campaignId: satoId,
      name: input.name,
      type: input.type,
      fileUrl: input.fileUrl,
      r2Key: input.r2Key,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      section: input.section ?? 'media',
      uploadedBy: uuidOrNull(requester.userId),
    })
    .returning();

  logger.info({ creativeId: row.id, campaignId: satoId, section: row.section }, 'Creative uploaded');

  // Day 3 — notify every linked buyer their portal has a new asset to
  // review. Fire-and-forget so Resend failures don't break upload. The
  // service rate-limits to 1 email per buyer per hour internally.
  const [campaignRow] = await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, satoId));
  notifyBuyersOfNewCreative({
    campaignId: satoId,
    campaignName: campaignRow?.name ?? 'your campaign',
    creativeName: row.name,
    section: (row.section as 'media' | 'copy_lp') ?? 'media',
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), creativeId: row.id },
      'Creative-review email notification failed (non-blocking)',
    );
  });

  return toDto(row);
}

/**
 * Resolve where a creative actually lives in R2 and generate a fresh signed
 * download URL for it. Splits the responsibility that used to be on each FE
 * page (portal hardcoded 'creatives'; agency hardcoded 'misc') — the server
 * now owns folder selection per row, derived from the stored file_url. This
 * is also the per-resource authz boundary backlog #4 was asking for: a staff
 * caller can only resolve creatives in their own business.
 *
 * Folder selection order:
 *   1. Parse the stored file_url path (authoritative — that's where the
 *      file physically was written at upload time).
 *   2. Fall back to ('misc', r2Key) if the URL is malformed but r2_key is
 *      set — every legacy creative landed in misc/ because the upload UI
 *      used folder="misc" until the same-day fix.
 *   3. Return null if neither yields a usable (folder, key).
 *
 * Returns null on auth failure, missing row, or unresolvable location so the
 * controller can map cleanly to 404.
 */
export async function getCreativeSignedUrlForStaff(
  id: string,
  requester: AuthPayload,
): Promise<string | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const [row] = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.id, id), eq(creatives.isDeleted, false)));
  if (!row) return null;
  if (!(await campaignBelongsToBusiness(row.campaignId, businessId))) return null;

  const location = resolveR2Location(row.fileUrl, row.r2Key);
  if (!location) return null;
  return getSignedDownloadUrl({ folder: location.folder, key: location.key, expiresInSeconds: 3600 });
}

/**
 * Shared (folder, key) resolver used by both staff and portal signed-url
 * paths. Exported so portal.service can reuse the same fallback rules without
 * duplicating the parse logic.
 */
export function resolveR2Location(
  fileUrl: string | null | undefined,
  r2Key: string | null | undefined,
): { folder: R2Folder; key: string } | null {
  const parsed = parseR2LocationFromFileUrl(fileUrl);
  if (parsed) return parsed;
  // Pre-fix uploads all landed in misc/ via FileUpload folder="misc" on the
  // agency campaign-detail page. If we couldn't recover a folder from the URL
  // but the row has an r2_key, that's where it lives.
  if (r2Key) return { folder: 'misc', key: r2Key };
  return null;
}

/** Soft-delete: marks isDeleted=true. R2 file is left in place. */
export async function softDeleteCreative(
  id: string,
  requester: AuthPayload,
): Promise<boolean> {
  const businessId = requester.businessId;
  if (!businessId) return false;

  const [row] = await db.select().from(creatives).where(eq(creatives.id, id));
  if (!row) return false;
  if (!(await campaignBelongsToBusiness(row.campaignId, businessId))) return false;

  await db
    .update(creatives)
    .set({ isDeleted: true, updatedAt: new Date() })
    .where(eq(creatives.id, id));

  logger.info({ creativeId: id }, 'Creative soft-deleted');
  return true;
}
