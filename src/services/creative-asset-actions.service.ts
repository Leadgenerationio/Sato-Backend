import { and, eq, ne } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { clients } from '../db/schema/clients.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { copyHash } from './creative-copy.service.js';
import { ApiError, accountClientMismatch, campaignClientMismatch, moveRequiresConfirm } from '../utils/api-error.js';
import { creativeBelongsToBusiness, type CreativeRow } from './creative-library.service.js';
import { assertCampaignBelongsToClient, resolveCampaignRef, type Caller } from './ad-account-rules.service.js';
import { domainEvents } from './events.js';

// MCP spec v1.0 update_asset, archive_asset, restore_asset. Nothing here deletes
// an asset or its file: archive only hides it from default lists.

async function load(caller: Caller, creativeId: string): Promise<CreativeRow> {
  const [row] = /^[0-9a-f-]{36}$/i.test(creativeId) ? await db.select().from(creatives).where(and(eq(creatives.id, creativeId), eq(creatives.isDeleted, false))) : [];
  if (!row || !(await creativeBelongsToBusiness(row, caller.businessId))) {
    throw new ApiError('not_found', 'That asset does not exist.', { hint: 'Use list_assets to find the creativeId.' });
  }
  return row;
}

export interface AssetSummary {
  creativeId: string; name: string; headline: string | null; bodyText: string | null; tags: string[];
  clientId: string | null; campaignId: string | null; archivedAt: string | null; archiveReason: string | null;
}
const summary = (r: CreativeRow): AssetSummary => ({
  creativeId: r.id, name: r.name, headline: r.headline ?? null, bodyText: r.bodyText ?? null, tags: r.tags, clientId: r.clientId ?? null, campaignId: r.campaignId ?? null,
  archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null, archiveReason: r.archiveReason ?? null,
});

export interface UpdateAssetInput {
  creativeId: string; name?: string; headline?: string; bodyText?: string; tags?: string[];
  campaignId?: string; clientId?: string; confirmMove?: boolean;
}

export async function updateAsset(caller: Caller, input: UpdateAssetInput): Promise<{ creative: AssetSummary; changedFields: string[]; before: AssetSummary }> {
  const row = await load(caller, input.creativeId);
  const before = summary(row);
  const set: Partial<typeof creatives.$inferInsert> = {};
  const changed: string[] = [];
  const mark = (field: string, patchKey: keyof typeof creatives.$inferInsert, value: unknown) => { (set as Record<string, unknown>)[patchKey] = value; changed.push(field); };

  if (input.name !== undefined && input.name !== row.name) mark('name', 'name', input.name);
  if (input.headline !== undefined && input.headline !== (row.headline ?? '')) mark('headline', 'headline', input.headline);
  if (input.bodyText !== undefined && input.bodyText !== (row.bodyText ?? '')) mark('bodyText', 'bodyText', input.bodyText);
  // A copy-only asset is identified by the hash of its text: keep the hash in step with an edit, and refuse an edit that would
  // make it the same copy as another live asset of the client (one creative per client and content).
  if (row.type === 'copy' && changed.some((f) => f === 'headline' || f === 'bodyText')) {
    const headline = (set.headline ?? row.headline ?? '') as string; const bodyText = (set.bodyText ?? row.bodyText ?? '') as string;
    if (!headline.trim() && !bodyText.trim()) throw new ApiError('validation_failed', 'A copy-only asset needs a headline or bodyText.', { fields: [{ field: 'headline', message: 'Cannot leave both empty' }] });
    const sha = copyHash(headline, bodyText);
    if (row.clientId) {
      const [other] = await db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.sha256, sha), eq(creatives.clientId, row.clientId), eq(creatives.isDeleted, false), ne(creatives.id, row.id)));
      if (other) throw new ApiError('duplicate', `Another asset of this client already has this exact copy (${other.id}).`, { hint: 'Use that asset, or change the text.', details: { creativeId: other.id } });
    }
    set.sha256 = sha;
  }
  if (input.tags !== undefined) {
    const next = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))].sort();
    if (JSON.stringify(next) !== JSON.stringify([...row.tags].sort())) mark('tags', 'tags', next);
  }

  // Moving to another client: needs confirmMove, and must not strand a live ad on the old client's account.
  let clientId = row.clientId;
  if (input.clientId && input.clientId !== row.clientId) {
    const [target] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, input.clientId), eq(clients.businessId, caller.businessId))).limit(1);
    if (!target) throw new ApiError('not_found', 'That client does not exist in this business.', { hint: 'Use list_clients to find the right clientId.' });
    // An asset with no client yet (copy-only or unfiled) is simply filed: nothing is being taken from anyone.
    if (row.clientId && !input.confirmMove) {
      const [prev] = row.clientId ? await db.select({ name: clients.companyName }).from(clients).where(eq(clients.id, row.clientId)).limit(1) : [];
      throw moveRequiresConfirm(prev?.name ?? 'its current client');
    }
    const live = await db.select({ platform: creativeAdLinks.platform, accountId: creativeAdLinks.platformAccountId }).from(creativeAdLinks)
      .where(and(eq(creativeAdLinks.creativeId, row.id), ne(creativeAdLinks.status, 'removed')));
    for (const l of live) {
      if (!l.accountId) continue;
      const [owner] = await db.select({ clientId: clientAdAccounts.clientId }).from(clientAdAccounts).where(and(eq(clientAdAccounts.accountId, l.accountId), eq(clientAdAccounts.businessId, caller.businessId)));
      if (owner && owner.clientId !== target.id) throw accountClientMismatch(l.accountId);
    }
    clientId = target.id;
    mark('clientId', 'clientId', target.id);
    // The old client's landing page no longer fits.
    if (row.landingPageId) {
      const [lp] = await db.select({ clientId: landingPages.clientId }).from(landingPages).where(eq(landingPages.id, row.landingPageId));
      if (lp && lp.clientId !== target.id) { set.landingPageId = null; changed.push('landingPage'); }
    }
  }

  // Campaign: a new one must belong to the client; after a move the current one must still fit.
  let campaignId = row.campaignId;
  if (input.campaignId) {
    const campaign = await resolveCampaignRef(input.campaignId, caller.businessId);
    if (clientId) await assertCampaignBelongsToClient(clientId, campaign.id);
    campaignId = campaign.id;
    if (campaign.id !== row.campaignId) mark('campaignId', 'campaignId', campaign.id);
  } else if (clientId !== row.clientId && row.campaignId && clientId) {
    try { await assertCampaignBelongsToClient(clientId, row.campaignId); } catch { throw campaignClientMismatch(); }
  }

  if (changed.length === 0) return { creative: before, changedFields: [], before };
  set.updatedAt = new Date();
  const [updated] = await db.update(creatives).set(set).where(eq(creatives.id, row.id)).returning();
  domainEvents.emit('creative.changed', { businessId: caller.businessId, data: { creativeId: row.id, clientId, campaignId } });
  return { creative: summary(updated!), changedFields: changed, before };
}

export async function archiveAsset(caller: Caller, creativeId: string, reason?: string): Promise<{ result: 'archived' | 'unchanged'; creative: AssetSummary; before: AssetSummary }> {
  const row = await load(caller, creativeId);
  const before = summary(row);
  if (row.archivedAt) return { result: 'unchanged', creative: before, before };
  const [updated] = await db.update(creatives).set({ archivedAt: new Date(), archivedBy: caller.userId, archiveReason: reason?.slice(0, 255) ?? null, updatedAt: new Date() }).where(eq(creatives.id, row.id)).returning();
  domainEvents.emit('creative.changed', { businessId: caller.businessId, data: { creativeId: row.id, clientId: row.clientId, archived: true } });
  return { result: 'archived', creative: summary(updated!), before };
}

export async function restoreAsset(caller: Caller, creativeId: string): Promise<{ result: 'restored' | 'unchanged'; creative: AssetSummary; before: AssetSummary }> {
  const row = await load(caller, creativeId);
  const before = summary(row);
  if (!row.archivedAt) return { result: 'unchanged', creative: before, before };
  const [updated] = await db.update(creatives).set({ archivedAt: null, archivedBy: null, archiveReason: null, updatedAt: new Date() }).where(eq(creatives.id, row.id)).returning();
  domainEvents.emit('creative.changed', { businessId: caller.businessId, data: { creativeId: row.id, clientId: row.clientId, archived: false } });
  return { result: 'restored', creative: summary(updated!), before };
}
