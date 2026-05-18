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
