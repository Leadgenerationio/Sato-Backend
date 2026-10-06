import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks, type CreativeAdLinkRow, type CreativeAdLinkStatus } from '../db/schema/creative-ad-links.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { ApiError, accountClientMismatch } from '../utils/api-error.js';
import { isUniqueViolation } from '../utils/pg-errors.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { creativeBelongsToBusiness, ensureLandingPage, type CreativeRow } from './creative-library.service.js';
import { domainEvents } from './events.js';
import { assertCampaignBelongsToClient, campaignsForAccount, resolveCampaignRef, type Caller } from './ad-account-rules.service.js';

// MCP spec v1.0 section 2: link_ad_platform_ids, unlink_ad_platform_ids and
// find_asset_by_platform_id. One asset is often used in several ads, accounts
// and platforms, so the ads live in creative_ad_links, not on the creative.
// The platform stored here uses the creatives vocabulary (meta, google, tiktok,
// taboola). Stato only records; it never writes to an ad platform.

export interface AdLinkInput {
  creativeId: string;
  platform: string;
  accountId: string;
  /** The Stato campaign (UUID or LeadByte number). Left out: the asset's campaign, then the account's. */
  campaignId?: string;
  /** The ad platform's own campaign ID and name. */
  platformCampaignId?: string;
  platformCampaignName?: string;
  adsetId?: string;
  adsetName?: string;
  adId?: string;
  adName?: string;
  platformCreativeId?: string;
  platformAssetId?: string;
  landingPageUrl?: string;
  /** A link is never created as removed; unlink_ad_platform_ids does that. */
  status?: Exclude<CreativeAdLinkStatus, 'removed'>;
}

export interface AdLinkDto {
  adLinkId: string;
  creativeId: string;
  clientId: string | null;
  campaignId: string | null;
  platform: string;
  accountId: string | null;
  platformCampaignId: string | null;
  platformCampaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
  adName: string | null;
  platformCreativeId: string | null;
  platformAssetId: string | null;
  landingPageId: string | null;
  status: CreativeAdLinkStatus;
  source: string;
  createdAt: string;
  removedAt: string | null;
}

export const toAdLinkDto = (l: CreativeAdLinkRow): AdLinkDto => ({
  adLinkId: l.id,
  creativeId: l.creativeId,
  clientId: l.clientId,
  campaignId: l.campaignId,
  platform: l.platform,
  accountId: l.platformAccountId,
  platformCampaignId: l.platformCampaignId,
  platformCampaignName: l.platformCampaignName,
  adsetId: l.platformAdsetId,
  adsetName: l.platformAdsetName,
  adId: l.platformAdId,
  adName: l.platformAdName,
  platformCreativeId: l.platformCreativeId,
  platformAssetId: l.platformAssetId,
  landingPageId: l.landingPageId,
  status: l.status,
  source: l.source,
  createdAt: l.createdAt.toISOString(),
  removedAt: l.removedAt ? l.removedAt.toISOString() : null,
});

const LIBRARY_PLATFORMS = new Set(['meta', 'google', 'tiktok', 'taboola']);

/** Any alias in, the creatives vocabulary out. */
function libraryPlatform(input: string): { stored: string; platform: string } {
  const stored = normalisePlatform(input);
  const platform = toSpecPlatform(stored);
  if (!LIBRARY_PLATFORMS.has(platform)) {
    throw new ApiError('validation_failed', `Ad links support meta, google, tiktok and taboola, not "${input}".`, { fields: [{ field: 'platform', message: 'Unsupported platform' }] });
  }
  return { stored, platform };
}

async function loadCreativeForCaller(caller: Caller, creativeId: string): Promise<CreativeRow> {
  const [row] = await db.select().from(creatives).where(and(eq(creatives.id, creativeId), eq(creatives.isDeleted, false)));
  if (!row || !(await creativeBelongsToBusiness(row, caller.businessId))) {
    throw new ApiError('not_found', 'That asset does not exist.', { hint: 'Use list_assets or find_asset_by_platform_id to find the creativeId.' });
  }
  return row;
}

export interface LinkAdResult {
  result: 'created' | 'unchanged' | 'updated' | 'duplicate';
  /** For duplicate: the link that already holds this ad (another asset's). Nothing was saved. */
  link: AdLinkDto;
  before: AdLinkDto | null;
}

/** The live link for an ad (or, with no ad ID, for this creative's own ad-less link). */
async function findLiveLink(businessId: string | null, platform: string, creativeId: string, input: AdLinkInput) {
  const live = ne(creativeAdLinks.status, 'removed');
  if (input.adId) {
    // The unique index on (platform, ad ID) is global, so look across businesses when asked.
    const [row] = await db.select().from(creativeAdLinks).where(and(
      eq(creativeAdLinks.platform, platform), eq(creativeAdLinks.platformAdId, input.adId), live,
      ...(businessId ? [eq(creativeAdLinks.businessId, businessId)] : []),
    ));
    return row;
  }
  const [row] = await db.select().from(creativeAdLinks).where(and(
    eq(creativeAdLinks.creativeId, creativeId), eq(creativeAdLinks.platform, platform), live,
    sql`${creativeAdLinks.platformAdId} is null`,
    sql`coalesce(${creativeAdLinks.platformCreativeId}, '') = ${input.platformCreativeId ?? ''}`,
    sql`coalesce(${creativeAdLinks.platformAssetId}, '') = ${input.platformAssetId ?? ''}`,
  ));
  return row;
}

const duplicateOf = (existing: CreativeAdLinkRow): LinkAdResult => ({ result: 'duplicate', link: toAdLinkDto(existing), before: toAdLinkDto(existing) });

export async function linkAdPlatformIds(caller: Caller & { source: 'mcp' | 'api' }, input: AdLinkInput): Promise<LinkAdResult> {
  if (!input.adId && !input.platformCreativeId && !input.platformAssetId) {
    throw new ApiError('validation_failed', 'Send at least one of adId, platformCreativeId or platformAssetId.', {
      fields: [{ field: 'adId', message: 'adId, platformCreativeId or platformAssetId is required' }],
      hint: 'Use the IDs the ad platform returned when you created the ad. They are strings.',
    });
  }
  if ((input.status as string | undefined) === 'removed') {
    throw new ApiError('validation_failed', 'A link cannot be created as removed.', {
      fields: [{ field: 'status', message: 'Use active, paused or unknown' }], hint: 'Use unlink_ad_platform_ids to remove a link.',
    });
  }
  const { stored, platform } = libraryPlatform(input.platform);
  const accountId = normaliseAccountId(input.platform, input.accountId);
  const creative = await loadCreativeForCaller(caller, input.creativeId);

  // The ad account decides the client; it must be linked, and it must be this asset's client.
  const [owner] = await db.select().from(clientAdAccounts).where(and(
    eq(clientAdAccounts.businessId, caller.businessId), eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, accountId),
  ));
  if (!owner) {
    throw new ApiError('account_not_linked', `The ${platform} account ${accountId} is not linked to a client.`, {
      hint: 'Ask the owner which client it belongs to, then call link_ad_account. Nothing was saved.',
    });
  }
  if (creative.clientId && owner.clientId !== creative.clientId) throw accountClientMismatch(accountId);
  const clientId = creative.clientId ?? owner.clientId;

  // The Stato campaign: what the caller sent, else the asset's. With neither, an
  // account that feeds several campaigns makes the caller choose (never a guess).
  let campaignId: string | null = null;
  if (input.campaignId) {
    const campaign = await resolveCampaignRef(input.campaignId);
    await assertCampaignBelongsToClient(clientId, campaign.id);
    campaignId = campaign.id;
  } else if (creative.campaignId) {
    campaignId = creative.campaignId;
  } else {
    const choices = await campaignsForAccount(stored, accountId);
    if (choices.length > 1) {
      throw new ApiError('validation_failed', `Ad account ${accountId} feeds ${choices.length} campaigns: send campaignId.`, {
        fields: [{ field: 'campaignId', message: 'Required when the account feeds several campaigns' }],
        hint: `Choose one: ${choices.map((c) => `${c.name} (${c.campaignId})`).join(', ')}. Nothing was saved.`,
        details: { campaigns: choices },
      });
    }
    campaignId = choices[0]?.campaignId ?? owner.campaignId ?? null;
  }

  // The ad already runs another asset: answer with it and save nothing (not even a landing page).
  const existing = await findLiveLink(caller.businessId, platform, creative.id, input);
  if (existing && existing.creativeId !== creative.id) return duplicateOf(existing);

  let landingPageId: string | null = null;
  if (input.landingPageUrl) landingPageId = (await ensureLandingPage(clientId, input.landingPageUrl, { campaignId })).page.id;

  const fields = {
    platformAccountId: accountId,
    platformCampaignId: input.platformCampaignId ?? null,
    platformCampaignName: input.platformCampaignName ?? null,
    platformAdsetId: input.adsetId ?? null,
    platformAdsetName: input.adsetName ?? null,
    platformAdId: input.adId ?? null,
    platformAdName: input.adName ?? null,
    platformCreativeId: input.platformCreativeId ?? null,
    platformAssetId: input.platformAssetId ?? null,
    landingPageId,
    status: input.status ?? 'active',
  };

  const settle = async (link: CreativeAdLinkRow): Promise<LinkAdResult> => {
    const before = toAdLinkDto(link);
    const now = new Date();
    // Only change what the caller sent; a call that omits a name must not blank one.
    const patch: Partial<typeof creativeAdLinks.$inferInsert> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) continue;
      // A repeat call that omits status keeps the stored one.
      if (k === 'status' && !input.status) continue;
      if ((link as Record<string, unknown>)[k] !== v) (patch as Record<string, unknown>)[k] = v;
    }
    if (input.campaignId && link.campaignId !== campaignId) patch.campaignId = campaignId;
    if (Object.keys(patch).length === 0) {
      await db.update(creativeAdLinks).set({ lastSeen: now }).where(eq(creativeAdLinks.id, link.id));
      return { result: 'unchanged', link: before, before };
    }
    const [row] = await db.update(creativeAdLinks).set({ ...patch, lastSeen: now, updatedAt: now }).where(eq(creativeAdLinks.id, link.id)).returning();
    return { result: 'updated', link: toAdLinkDto(row!), before };
  };

  let result: LinkAdResult['result'];
  let linkDto: AdLinkDto;
  let before: AdLinkDto | null = null;
  const now = new Date();
  if (existing) {
    const settled = await settle(existing);
    if (settled.result === 'unchanged') return settled;
    result = 'updated';
    before = settled.before;
    linkDto = settled.link;
  } else {
    try {
      const [inserted] = await db.insert(creativeAdLinks).values({
        businessId: caller.businessId, creativeId: creative.id, clientId, campaignId, platform,
        ...fields, source: caller.source, linkedBy: caller.userId, createdByKeyId: caller.keyId,
      }).returning();
      linkDto = toAdLinkDto(inserted!);
      result = 'created';
    } catch (err) {
      // Two calls at once for the same ad: the unique index let one through. Drizzle wraps the
      // Postgres error, so the code is on err.cause. Settle on the winner.
      if (!isUniqueViolation(err)) throw err;
      const winner = await findLiveLink(null, platform, creative.id, input);
      if (!winner) throw err;
      if (winner.creativeId !== creative.id || winner.businessId !== caller.businessId) {
        // Another asset holds it; another business's IDs are not shown.
        if (winner.businessId !== caller.businessId) throw new ApiError('duplicate', `That ${platform} ad is already linked to another asset.`, { hint: 'Nothing was saved.' });
        return duplicateOf(winner);
      }
      return settle(winner);
    }
  }

  // The first link also fills the old single platform columns (kept for the portal and the pull).
  // Portal uploads carry platform 'manual', which counts as empty.
  const legacy: Partial<typeof creatives.$inferInsert> = {};
  if (!creative.platform || creative.platform === 'manual') legacy.platform = platform;
  if (!creative.platformAccountId) legacy.platformAccountId = accountId;
  if (!creative.platformAdId && input.adId) legacy.platformAdId = input.adId;
  if (!creative.platformCreativeId && input.platformCreativeId) legacy.platformCreativeId = input.platformCreativeId;
  if (!creative.platformCampaignId && input.platformCampaignId) legacy.platformCampaignId = input.platformCampaignId;
  if (!creative.platformCampaignName && input.platformCampaignName) legacy.platformCampaignName = input.platformCampaignName;
  if (!creative.landingPageId && landingPageId) legacy.landingPageId = landingPageId;
  if (Object.keys(legacy).length) await db.update(creatives).set({ ...legacy, updatedAt: now }).where(eq(creatives.id, creative.id));

  domainEvents.emit('creative.changed', { businessId: caller.businessId, data: { creativeId: creative.id, clientId, platform } });
  return { result, link: linkDto, before };
}

export interface UnlinkResult { result: 'removed' | 'unchanged'; link: AdLinkDto; before: AdLinkDto }

/** A wrong link is removed, never deleted: it stays in history. */
export async function unlinkAdPlatformIds(caller: Caller, adLinkId: string): Promise<UnlinkResult> {
  const [link] = await db.select().from(creativeAdLinks).where(and(eq(creativeAdLinks.id, adLinkId), eq(creativeAdLinks.businessId, caller.businessId)));
  if (!link) throw new ApiError('not_found', 'That ad link does not exist.', { hint: 'Use find_asset_by_platform_id or get_asset to see the adLinkId.' });
  const before = toAdLinkDto(link);
  if (link.status === 'removed') return { result: 'unchanged', link: before, before };
  const now = new Date();
  const [row] = await db.update(creativeAdLinks).set({ status: 'removed', removedAt: now, updatedAt: now }).where(eq(creativeAdLinks.id, link.id)).returning();
  domainEvents.emit('creative.changed', { businessId: caller.businessId, data: { creativeId: link.creativeId, clientId: link.clientId, platform: link.platform } });
  return { result: 'removed', link: toAdLinkDto(row!), before };
}

export interface FoundAsset {
  found: boolean;
  creative: { id: string; name: string; type: string | null; clientId: string | null; campaignId: string | null; approvalStatus: string; fileStatus: string; archivedAt: string | null; sha256: string | null } | null;
  adLink: AdLinkDto | null;
}

export interface FindAssetInput { platform?: string; adId?: string; platformCreativeId?: string; platformAssetId?: string; sha256?: string }

/** Check before registering, to avoid duplicates. Nothing found is an answer, not an error. */
export async function findAssetByPlatformId(caller: Caller, input: FindAssetInput): Promise<FoundAsset> {
  const none: FoundAsset = { found: false, creative: null, adLink: null };
  const dto = (c: CreativeRow): FoundAsset['creative'] => ({
    id: c.id, name: c.name, type: c.type, clientId: c.clientId, campaignId: c.campaignId, approvalStatus: c.status, fileStatus: c.fileStatus,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null, sha256: c.sha256,
  });

  if (input.sha256) {
    const rows = await db.select().from(creatives).where(and(eq(creatives.sha256, input.sha256.toLowerCase()), eq(creatives.isDeleted, false))).orderBy(desc(creatives.createdAt));
    for (const c of rows) if (await creativeBelongsToBusiness(c, caller.businessId)) return { found: true, creative: dto(c), adLink: null };
    return none;
  }
  if (!input.adId && !input.platformCreativeId && !input.platformAssetId) {
    throw new ApiError('validation_failed', 'Send platform plus one of adId, platformCreativeId or platformAssetId, or a sha256.', {
      fields: [{ field: 'adId', message: 'adId, platformCreativeId, platformAssetId or sha256 is required' }],
    });
  }
  if (!input.platform) throw new ApiError('validation_failed', 'platform is required with an ad or creative ID.', { fields: [{ field: 'platform', message: 'Required' }] });
  const { platform } = libraryPlatform(input.platform);

  const idMatch = input.adId ? eq(creativeAdLinks.platformAdId, input.adId)
    : input.platformCreativeId ? eq(creativeAdLinks.platformCreativeId, input.platformCreativeId)
    : eq(creativeAdLinks.platformAssetId, input.platformAssetId!);
  const links = await db.select().from(creativeAdLinks)
    .where(and(eq(creativeAdLinks.businessId, caller.businessId), eq(creativeAdLinks.platform, platform), idMatch))
    .orderBy(sql`(${creativeAdLinks.status} = 'removed')`, desc(creativeAdLinks.createdAt));
  for (const l of links) {
    const [c] = await db.select().from(creatives).where(and(eq(creatives.id, l.creativeId), eq(creatives.isDeleted, false)));
    if (c) return { found: true, creative: dto(c), adLink: toAdLinkDto(l) };
  }
  // Older creatives registered before ad links existed.
  if (input.platformCreativeId || input.adId) {
    const col = input.adId ? creatives.platformAdId : creatives.platformCreativeId;
    const [c] = await db.select().from(creatives).where(and(eq(creatives.platform, platform), eq(col, (input.adId ?? input.platformCreativeId)!), eq(creatives.isDeleted, false)));
    if (c && (await creativeBelongsToBusiness(c, caller.businessId))) return { found: true, creative: dto(c), adLink: null };
  }
  return none;
}
