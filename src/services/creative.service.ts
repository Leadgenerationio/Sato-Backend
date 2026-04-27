import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clients } from '../db/schema/clients.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

/** Verify a campaign belongs to a client owned by the requester's business. */
async function campaignBelongsToBusiness(campaignId: string, businessId: string): Promise<boolean> {
  const [row] = await db
    .select({ businessId: clients.businessId })
    .from(campaigns)
    .innerJoin(clients, eq(campaigns.clientId, clients.id))
    .where(eq(campaigns.id, campaignId));
  return !!row && row.businessId === businessId;
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

  if (!(await campaignBelongsToBusiness(campaignId, businessId))) return [];

  const rows = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), eq(creatives.isDeleted, false)));
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
}

export async function createCreative(
  input: CreateCreativeInput,
  requester: AuthPayload,
): Promise<CreativeDto | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  if (!(await campaignBelongsToBusiness(input.campaignId, businessId))) return null;

  const [row] = await db
    .insert(creatives)
    .values({
      campaignId: input.campaignId,
      name: input.name,
      type: input.type,
      fileUrl: input.fileUrl,
      r2Key: input.r2Key,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      uploadedBy: requester.userId,
    })
    .returning();

  logger.info({ creativeId: row.id, campaignId: input.campaignId }, 'Creative uploaded');
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
