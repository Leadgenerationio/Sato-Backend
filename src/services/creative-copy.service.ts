import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { AppError } from '../utils/errors.js';
import { isUniqueViolation } from '../utils/pg-errors.js';
import { logger } from '../utils/logger.js';
import { domainEvents } from './events.js';
import { campaignInBusiness, clientInBusiness, creativeBelongsToBusiness, ensureLandingPage } from './creative-library.service.js';

// Copy-only assets (spec v1.0, Sam's decision: "Copy-only assets: yes"). Ad copy with no file: type 'copy', headline and/or
// body text, kept in `creatives` so approvals, ad links and history work as for any asset. The "file hash" that makes the same
// file for the same client one creative is, here, the hash of the normalised text, so the same copy for the same client is one
// creative too.

/** Trim and unify line endings, so the same copy typed twice hashes the same. */
const norm = (s: string | undefined | null) => (s ?? '').replace(/\r\n?/g, '\n').trim();

export const copyHash = (headline?: string | null, bodyText?: string | null): string =>
  createHash('sha256').update(JSON.stringify(['copy', norm(headline), norm(bodyText)])).digest('hex');

export interface CopyInput {
  businessId: string;
  clientId: string;
  campaignId?: string | null;
  platform: string;
  platformAccountId?: string;
  platformCreativeId?: string;
  headline?: string;
  bodyText?: string;
  landingPageUrl?: string;
  name?: string;
  uploadedBy?: string | null;
}

type CreativeRow = typeof creatives.$inferSelect;

/** The name shown in lists when none is given: the headline, else the start of the body. */
const nameFor = (headline?: string, bodyText?: string) => (norm(headline) || norm(bodyText).slice(0, 80) || 'Ad copy').slice(0, 255);

export async function upsertCopyCreative(input: CopyInput): Promise<{ creative: CreativeRow; created: boolean }> {
  const headline = norm(input.headline); const bodyText = norm(input.bodyText);
  if (!headline && !bodyText) throw new AppError(422, 'A copy-only asset needs a headline or bodyText');
  if (!(await clientInBusiness(input.clientId, input.businessId))) throw new AppError(404, 'Client not found');
  if (input.campaignId && !(await campaignInBusiness(input.campaignId, input.businessId))) throw new AppError(404, 'Campaign not found');
  const sha256 = copyHash(headline, bodyText);
  const now = new Date();

  let existing: CreativeRow | undefined;
  if (input.platformCreativeId) {
    [existing] = await db.select().from(creatives).where(and(eq(creatives.platform, input.platform), eq(creatives.platformCreativeId, input.platformCreativeId), eq(creatives.isDeleted, false)));
    // The same rules as the file path (upsertPlatformCreative): another business's id is never updated, and neither is
    // another client's inside this business (that would silently file under a client the account does not belong to).
    if (existing && !(await creativeBelongsToBusiness(existing, input.businessId))) {
      throw new AppError(409, 'This platform creative id is already registered to another business');
    }
    if (existing && existing.clientId !== input.clientId) {
      throw new AppError(409, 'This platform creative id is already registered to another client');
    }
  }
  if (!existing) {
    [existing] = await db.select().from(creatives).where(and(eq(creatives.sha256, sha256), eq(creatives.clientId, input.clientId), eq(creatives.isDeleted, false)));
  }
  const landingPageId = input.landingPageUrl ? (await ensureLandingPage(input.clientId, input.landingPageUrl, { campaignId: input.campaignId ?? null })).page.id : undefined;

  if (existing) {
    const patch: Partial<typeof creatives.$inferInsert> = { lastSeen: now, updatedAt: now };
    if (existing.type === 'copy' && (existing.headline ?? '') !== headline) patch.headline = headline;
    if (existing.type === 'copy' && (existing.bodyText ?? '') !== bodyText) patch.bodyText = bodyText;
    if (existing.type === 'copy' && sha256 !== existing.sha256) patch.sha256 = sha256;
    if (landingPageId) patch.landingPageId = landingPageId;
    if (input.campaignId && !existing.campaignId) patch.campaignId = input.campaignId;
    if (input.name) patch.name = input.name;
    const [row] = await db.update(creatives).set(patch).where(eq(creatives.id, existing.id)).returning();
    const changed = Object.keys(patch).some((k) => !['lastSeen', 'updatedAt'].includes(k));
    if (changed) domainEvents.emit('creative.changed', { businessId: input.businessId, data: { creativeId: row!.id, clientId: row!.clientId, platform: row!.platform } });
    return { creative: row!, created: false };
  }

  try {
    const [row] = await db.insert(creatives).values({
      clientId: input.clientId,
      campaignId: input.campaignId ?? null,
      platform: input.platform,
      platformAccountId: input.platformAccountId ?? null,
      platformCreativeId: input.platformCreativeId ?? null,
      name: input.name ?? nameFor(headline, bodyText),
      headline: headline || null,
      bodyText: bodyText || null,
      type: 'copy',
      section: 'copy_lp',
      fileUrl: null,
      r2Key: null,
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength(`${headline}\n${bodyText}`),
      sha256,
      fileStatus: 'ready',
      landingPageId: landingPageId ?? null,
      uploadedBy: input.uploadedBy ?? null,
      firstSeen: now,
      lastSeen: now,
    }).returning();
    domainEvents.emit('creative.added', { businessId: input.businessId, data: { creativeId: row!.id, clientId: input.clientId, campaignId: input.campaignId ?? null, platform: input.platform, platformCreativeId: input.platformCreativeId ?? null } });
    return { creative: row!, created: true };
  } catch (err) {
    // The same copy for the same client raced in (the unique index on client + hash): return the one that won.
    if (!isUniqueViolation(err)) throw err;
    const [winner] = await db.select().from(creatives).where(and(eq(creatives.sha256, sha256), eq(creatives.clientId, input.clientId), eq(creatives.isDeleted, false)));
    if (!winner) throw err;
    logger.warn({ creativeId: winner.id }, 'A second copy-only asset for the same text was refused by the unique index; returning the existing one');
    return { creative: winner, created: false };
  }
}
