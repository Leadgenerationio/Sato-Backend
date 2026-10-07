import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { AppError } from '../utils/errors.js';
import { isCreativeShaRace } from '../utils/pg-errors.js';
import { logger } from '../utils/logger.js';
import { domainEvents } from './events.js';
import { campaignUsableBy, clientInBusiness, creativeBelongsToBusiness, ensureLandingPage } from './creative-library.service.js';

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = { creative: CreativeRow; created: boolean; event: 'creative.added' | 'creative.changed' | null };

/**
 * One transaction per call. Calls that carry the same platformCreativeId take the same advisory lock, so the lookup by that
 * id and the write that follows cannot interleave (nothing in the schema makes the id unique, and a migration over live data
 * is not worth it for this).
 */
async function inTx<T>(input: CopyInput, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (input.platformCreativeId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`copy:${input.platform}:${input.platformCreativeId}`}, 0))`);
    return fn(tx);
  });
}

/** Apply a call to a creative that already exists: new text, landing page, campaign, name, platform id. */
async function applyToExisting(tx: Tx, existing: CreativeRow, input: CopyInput, f: { headline: string; bodyText: string; sha256: string; landingPageId?: string }): Promise<Outcome> {
  const now = new Date();
  const patch: Partial<typeof creatives.$inferInsert> = { lastSeen: now, updatedAt: now };
  if (existing.type === 'copy' && (existing.headline ?? '') !== f.headline) patch.headline = f.headline;
  if (existing.type === 'copy' && (existing.bodyText ?? '') !== f.bodyText) patch.bodyText = f.bodyText;
  if (existing.type === 'copy' && f.sha256 !== existing.sha256) patch.sha256 = f.sha256;
  if (f.landingPageId) patch.landingPageId = f.landingPageId;
  if (input.campaignId && !existing.campaignId) patch.campaignId = input.campaignId;
  if (input.platformCreativeId && !existing.platformCreativeId) patch.platformCreativeId = input.platformCreativeId;
  if (input.name) patch.name = input.name;
  let row: CreativeRow | undefined;
  try {
    [row] = await tx.update(creatives).set(patch).where(eq(creatives.id, existing.id)).returning();
  } catch (err) {
    // New text that another live asset of this client already has: the same refusal updateAsset gives, not a raw 500.
    if (isCreativeShaRace(err)) throw new AppError(409, 'Another asset of this client already has this text');
    throw err;
  }
  const changed = Object.keys(patch).some((k) => !['lastSeen', 'updatedAt'].includes(k));
  return { creative: row!, created: false, event: changed ? 'creative.changed' : null };
}

export async function upsertCopyCreative(input: CopyInput): Promise<{ creative: CreativeRow; created: boolean }> {
  const headline = norm(input.headline); const bodyText = norm(input.bodyText);
  if (!headline && !bodyText) throw new AppError(422, 'A copy-only asset needs a headline or bodyText');
  if (!(await clientInBusiness(input.clientId, input.businessId))) throw new AppError(404, 'Client not found');
  if (input.campaignId && !(await campaignUsableBy(input.campaignId, input.businessId, input.clientId))) throw new AppError(404, 'Campaign not found');
  const sha256 = copyHash(headline, bodyText);
  const now = new Date();
  const landingPageId = input.landingPageUrl ? (await ensureLandingPage(input.clientId, input.landingPageUrl, { campaignId: input.campaignId ?? null })).page.id : undefined;
  const f = { headline, bodyText, sha256, landingPageId };
  const bySha = (q: Tx | typeof db) => q.select().from(creatives).where(and(eq(creatives.sha256, sha256), eq(creatives.clientId, input.clientId), eq(creatives.isDeleted, false)));

  let out: Outcome;
  try {
    out = await inTx(input, async (tx) => {
      let existing: CreativeRow | undefined;
      if (input.platformCreativeId) {
        [existing] = await tx.select().from(creatives).where(and(eq(creatives.platform, input.platform), eq(creatives.platformCreativeId, input.platformCreativeId), eq(creatives.isDeleted, false)));
        // The same rules as the file path (upsertPlatformCreative): another business's id is never updated, and neither is
        // another client's inside this business (that would silently file under a client the account does not belong to).
        if (existing && !(await creativeBelongsToBusiness(existing, input.businessId, tx))) {
          throw new AppError(409, 'This platform creative id is already registered to another business');
        }
        if (existing && existing.clientId !== input.clientId) {
          throw new AppError(409, 'This platform creative id is already registered to another client');
        }
      }
      if (!existing) [existing] = await bySha(tx);
      if (existing) return applyToExisting(tx, existing, input, f);

      const [row] = await tx.insert(creatives).values({
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
      return { creative: row!, created: true, event: 'creative.added' };
    });
  } catch (err) {
    // The same copy for the same client raced in (the unique index on client + hash): the one that won gets this call's
    // landing page, campaign, name and platform id, as if this call had arrived a moment later.
    if (!isCreativeShaRace(err)) throw err;
    const [winner] = await bySha(db);
    if (!winner) throw err;
    logger.warn({ creativeId: winner.id }, 'A second copy-only asset for the same text was refused by the unique index; returning the existing one');
    out = await inTx(input, (tx) => applyToExisting(tx, winner, input, f));
  }

  if (out.event === 'creative.added') {
    domainEvents.emit('creative.added', { businessId: input.businessId, data: { creativeId: out.creative.id, clientId: input.clientId, campaignId: input.campaignId ?? null, platform: input.platform, platformCreativeId: input.platformCreativeId ?? null } });
  } else if (out.event === 'creative.changed') {
    domainEvents.emit('creative.changed', { businessId: input.businessId, data: { creativeId: out.creative.id, clientId: out.creative.clientId, platform: out.creative.platform } });
  }
  return { creative: out.creative, created: out.created };
}
