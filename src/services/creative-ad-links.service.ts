import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks, type CreativeAdLinkRow, type CreativeAdLinkSource, type CreativeAdLinkStatus } from '../db/schema/creative-ad-links.js';
import { clients } from '../db/schema/clients.js';
import { creativeInBusiness, ensureLandingPage } from './creative-library.service.js';
import { resolveOwnership, requireLinkedAccount, campaignsForAccount, type CampaignChoice } from './asset-rules.service.js';
import { domainEvents } from './events.js';
import { toCreativePlatform, apiPlatformOut } from '../utils/api-platform.js';
import { ApiError } from '../utils/api-error.js';

// Ad links (MCP spec v1.0 §2 "Ad-platform IDs", step 1d): which platform ads a
// Stato creative runs in. One creative can sit in many ads, accounts and
// platforms. Stato only records the IDs; it never writes to Meta, Google or
// TikTok (spec §1.2).
//
// No duplicates (§2.1): the same (platform, ad ID) is one live link, and a
// link without an ad ID is matched on the creative + platform creative ID.
// A second call with the same IDs answers unchanged/updated, and an ad that
// already runs another creative answers duplicate with the existing IDs,
// never an error.

export interface WriteContext {
  businessId: string;
  /** The signed-in user, or null for an API key (keys are recorded by id). */
  userId: string | null;
  apiKeyId: string | null;
  source: CreativeAdLinkSource;
}

export interface LinkAdPlatformIdsInput {
  creativeId: string;
  platform: string;
  accountId: string;
  /** Stato campaign (UUID or LeadByte number). Defaults to the creative's campaign, then the ad account's. */
  campaignId?: string | null;
  platformCampaignId?: string | null;
  platformCampaignName?: string | null;
  /** Meta ad set, Google ad group / asset group, TikTok ad group. Taboola has none. */
  platformAdsetId?: string | null;
  platformAdsetName?: string | null;
  platformAdId?: string | null;
  platformAdName?: string | null;
  platformCreativeId?: string | null;
  /** Meta image hash or video ID, Google asset resource name, TikTok video or image ID. */
  platformAssetId?: string | null;
  landingPageUrl?: string | null;
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
  platformAdsetId: string | null;
  platformAdsetName: string | null;
  platformAdId: string | null;
  platformAdName: string | null;
  platformCreativeId: string | null;
  platformAssetId: string | null;
  landingPageId: string | null;
  status: CreativeAdLinkStatus;
  source: CreativeAdLinkSource;
  firstSeen: string;
  lastSeen: string;
  removedAt: string | null;
}

export function adLinkDto(r: CreativeAdLinkRow): AdLinkDto {
  return {
    adLinkId: r.id,
    creativeId: r.creativeId,
    clientId: r.clientId ?? null,
    campaignId: r.campaignId ?? null,
    platform: apiPlatformOut(r.platform)!,
    accountId: r.platformAccountId ?? null,
    platformCampaignId: r.platformCampaignId ?? null,
    platformCampaignName: r.platformCampaignName ?? null,
    platformAdsetId: r.platformAdsetId ?? null,
    platformAdsetName: r.platformAdsetName ?? null,
    platformAdId: r.platformAdId ?? null,
    platformAdName: r.platformAdName ?? null,
    platformCreativeId: r.platformCreativeId ?? null,
    platformAssetId: r.platformAssetId ?? null,
    landingPageId: r.landingPageId ?? null,
    status: r.status,
    source: r.source,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    removedAt: r.removedAt ? r.removedAt.toISOString() : null,
  };
}

export type LinkResult = 'created' | 'updated' | 'unchanged' | 'duplicate';

export interface LinkAdPlatformIdsOutput {
  result: LinkResult;
  adLink: AdLinkDto;
  /** For duplicate: the creative that already runs in this ad. */
  existingCreativeId?: string;
  /** For the audit log. */
  before: AdLinkDto | null;
  after: AdLinkDto | null;
}

const clean = (v: string | null | undefined) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : null;
};

/** The fields a repeat call may change on an existing link (IDs that identify it never change). */
const MUTABLE = [
  'campaignId', 'platformAccountId', 'platformCampaignId', 'platformCampaignName', 'platformAdsetId', 'platformAdsetName',
  'platformAdName', 'platformCreativeId', 'platformAssetId', 'landingPageId', 'status',
] as const;

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505'
  || (err as { cause?: { code?: string } })?.cause?.code === '23505';

async function findLiveLink(businessId: string, platform: string, creativeId: string, adId: string | null, platformCreativeId: string | null) {
  const live = and(eq(creativeAdLinks.businessId, businessId), eq(creativeAdLinks.platform, platform), ne(creativeAdLinks.status, 'removed'));
  if (adId) {
    const [byAd] = await db.select().from(creativeAdLinks).where(and(live, eq(creativeAdLinks.platformAdId, adId)));
    return byAd ?? null;
  }
  // No ad ID: this creative's own ad-less link with the same platform creative
  // ID is the same link (the key of creative_ad_links_creative_uq, which ignores
  // the asset ID). Otherwise a platform creative ID another creative already
  // holds makes this a duplicate.
  const [own] = await db.select().from(creativeAdLinks).where(and(
    live, eq(creativeAdLinks.creativeId, creativeId), isNull(creativeAdLinks.platformAdId),
    platformCreativeId ? eq(creativeAdLinks.platformCreativeId, platformCreativeId) : isNull(creativeAdLinks.platformCreativeId),
  ));
  if (own) return own;
  if (!platformCreativeId) return null;
  const [other] = await db.select().from(creativeAdLinks).where(and(
    live, eq(creativeAdLinks.platformCreativeId, platformCreativeId), ne(creativeAdLinks.creativeId, creativeId),
  ));
  return other ?? null;
}

/**
 * Record that a creative runs in a platform ad (link_ad_platform_ids). The ad
 * account must be linked to the creative's client; the campaign must be one
 * of that client's (or shared). Nothing is saved when a rule fails.
 */
export async function linkAdPlatformIds(ctx: WriteContext, input: LinkAdPlatformIdsInput): Promise<LinkAdPlatformIdsOutput> {
  const platform = toCreativePlatform(input.platform);
  if (!platform) {
    throw new ApiError('validation_failed', `Ads on "${input.platform}" can't be linked`, {
      fields: ['platform'], hint: 'Use one of meta, google, tiktok, taboola.',
    });
  }
  const adId = clean(input.platformAdId);
  const platformCreativeId = clean(input.platformCreativeId);
  const platformAssetId = clean(input.platformAssetId);
  if (!adId && !platformCreativeId && !platformAssetId) {
    throw new ApiError('validation_failed', 'Send at least one of platformAdId, platformCreativeId or platformAssetId', {
      fields: ['platformAdId', 'platformCreativeId', 'platformAssetId'],
    });
  }

  const [creative] = await db.select().from(creatives)
    .where(and(eq(creatives.id, input.creativeId), eq(creatives.isDeleted, false), creativeInBusiness(ctx.businessId)));
  if (!creative) {
    throw new ApiError('not_found', `Creative ${input.creativeId} not found`, { fields: ['creativeId'], hint: 'list_assets or find_asset_by_platform_id finds the creativeId.' });
  }
  if (creative.archivedAt) {
    throw new ApiError('validation_failed', 'This creative is archived', { fields: ['creativeId'], hint: 'Call restore_asset first if it is running again.' });
  }

  const owner = await resolveOwnership({
    businessId: ctx.businessId,
    platform: input.platform,
    accountId: input.accountId,
    clientId: creative.clientId,
    clientFrom: 'creative',
    campaignId: clean(input.campaignId) ?? creative.campaignId,
  });
  const account = owner.account!;

  const existing = await findLiveLink(ctx.businessId, platform, creative.id, adId, platformCreativeId);
  if (existing && existing.creativeId !== creative.id) {
    // The ad already runs another creative: answer with it and save nothing.
    const current = adLinkDto(existing);
    return { result: 'duplicate', adLink: current, existingCreativeId: existing.creativeId, before: current, after: null };
  }

  let landingPageId: string | null = null;
  const lpUrl = clean(input.landingPageUrl);
  if (lpUrl && owner.clientId) {
    landingPageId = (await ensureLandingPage(owner.clientId, lpUrl, { campaignId: owner.campaignId })).page.id;
  }

  const wanted = {
    campaignId: owner.campaignId,
    platformAccountId: account.accountId,
    platformCampaignId: clean(input.platformCampaignId),
    platformCampaignName: clean(input.platformCampaignName),
    platformAdsetId: clean(input.platformAdsetId),
    platformAdsetName: clean(input.platformAdsetName),
    platformAdName: clean(input.platformAdName),
    platformCreativeId,
    platformAssetId,
    landingPageId,
    status: input.status ?? null,
  } satisfies Partial<Record<(typeof MUTABLE)[number], unknown>>;

  const settle = async (existing: CreativeAdLinkRow): Promise<LinkAdPlatformIdsOutput> => {
    const before = adLinkDto(existing);
    if (existing.creativeId !== creative.id) {
      return { result: 'duplicate', adLink: before, existingCreativeId: existing.creativeId, before, after: null };
    }
    // A repeat call only fills or changes what it sends; a field left out keeps its value.
    const patch: Record<string, unknown> = {};
    for (const k of MUTABLE) {
      const next = wanted[k];
      if (next === null || next === undefined) continue;
      if (k === 'campaignId' && !clean(input.campaignId)) continue;
      if (existing[k] !== next) patch[k] = next;
    }
    const now = new Date();
    const changed = Object.keys(patch).length > 0;
    const [row] = await db.update(creativeAdLinks)
      .set({ ...patch, lastSeen: now, ...(changed ? { updatedAt: now } : {}) })
      .where(eq(creativeAdLinks.id, existing.id)).returning();
    const after = adLinkDto(row!);
    if (changed) emitChanged(ctx.businessId, row!, 'ad_link_updated');
    return { result: changed ? 'updated' : 'unchanged', adLink: after, before, after };
  };

  if (existing) return settle(existing);

  let row: CreativeAdLinkRow;
  try {
    [row] = await db.insert(creativeAdLinks).values({
      businessId: ctx.businessId,
      creativeId: creative.id,
      clientId: owner.clientId,
      platform,
      platformAdId: adId,
      ...wanted,
      status: input.status ?? 'active',
      source: ctx.source,
      linkedBy: ctx.userId,
      createdByKeyId: ctx.apiKeyId,
    }).returning() as [CreativeAdLinkRow];
  } catch (err) {
    // Two calls for the same ad at once: the unique index picks one, the other settles on it.
    if (!isUniqueViolation(err)) throw err;
    const winner = await findLiveLink(ctx.businessId, platform, creative.id, adId, platformCreativeId);
    if (!winner) throw err;
    return settle(winner);
  }

  await fillLegacyColumns(creative, row);
  emitChanged(ctx.businessId, row, 'ad_link_added');
  const after = adLinkDto(row);
  return { result: 'created', adLink: after, before: null, after };
}

/**
 * The old single platform_* columns on creatives stay read-only for two
 * releases (PR #71). A creative that has none yet gets them from its first
 * link, so the portal and the scheduled pull (which match on them) see it.
 */
async function fillLegacyColumns(creative: typeof creatives.$inferSelect, link: CreativeAdLinkRow) {
  if (creative.platformAdId || creative.platformCreativeId) return;
  await db.update(creatives).set({
    platform: link.platform,
    platformAccountId: link.platformAccountId,
    platformAdId: link.platformAdId,
    platformCreativeId: link.platformCreativeId,
    platformCampaignId: link.platformCampaignId,
    platformCampaignName: link.platformCampaignName,
    updatedAt: new Date(),
  }).where(eq(creatives.id, creative.id));
}

function emitChanged(businessId: string, link: CreativeAdLinkRow, change: 'ad_link_added' | 'ad_link_updated') {
  domainEvents.emit('creative.changed', {
    businessId,
    data: { creativeId: link.creativeId, clientId: link.clientId, change, adLinkId: link.id, platform: apiPlatformOut(link.platform), platformAdId: link.platformAdId },
  });
}

/** Live ad links of one creative, newest first (get_asset uses this). */
export async function adLinksForCreative(businessId: string, creativeId: string): Promise<AdLinkDto[]> {
  const rows = await db.select().from(creativeAdLinks)
    .where(and(eq(creativeAdLinks.businessId, businessId), eq(creativeAdLinks.creativeId, creativeId), ne(creativeAdLinks.status, 'removed')));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(adLinkDto);
}

export interface FindClientByAdAccountOutput {
  platform: string;
  accountId: string;
  client: { clientId: string; name: string; currency: string | null };
  /** The campaign set on the account link (null if none). */
  campaign: { campaignId: string; name: string } | null;
  /** Every campaign the account is known to feed. More than one → the caller must send campaignId. */
  campaigns: CampaignChoice[];
  campaignRequired: boolean;
}

/** find_client_by_ad_account: the client that owns an ad account, and the campaigns it feeds. */
export async function findClientByAdAccount(businessId: string, platform: string, accountId: string): Promise<FindClientByAdAccountOutput> {
  const account = await requireLinkedAccount(businessId, platform, accountId);
  const [client] = await db.select({ currency: clients.currency }).from(clients).where(eq(clients.id, account.clientId));
  const choices = await campaignsForAccount(businessId, account);
  const def = choices.find((c) => c.from === 'account');
  return {
    platform: account.platform,
    accountId: account.accountId,
    client: { clientId: account.clientId, name: account.clientName, currency: client?.currency ?? null },
    campaign: def ? { campaignId: def.campaignId, name: def.name } : null,
    campaigns: choices,
    campaignRequired: choices.length > 1,
  };
}
