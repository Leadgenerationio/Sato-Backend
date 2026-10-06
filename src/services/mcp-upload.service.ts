import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { clients } from '../db/schema/clients.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { AppError } from '../utils/errors.js';
import { ApiError, accountClientMismatch, accountNotLinked } from '../utils/api-error.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { upsertPlatformCreative } from './creative-library.service.js';
import { assertCampaignBelongsToClient, campaignsForAccount, resolveCampaignRef, type Caller } from './ad-account-rules.service.js';
import { linkAdPlatformIds, toAdLinkDto, type AdLinkDto, type AdLinkInput } from './creative-ad-links.service.js';

// MCP spec v1.0 upload_asset for files that arrive as a sourceUrl (up to 50 MB
// today). The ad account decides the client; clientId is only a cross-check.

export interface UploadAssetInput {
  mediaType: 'image' | 'video';
  name?: string;
  sourceUrl: string;
  clientId?: string;
  platform?: string;
  platformAccountId?: string;
  campaignId?: string;
  headline?: string;
  bodyText?: string;
  landingPageUrl?: string;
  tags?: string[];
  adLink?: Omit<AdLinkInput, 'creativeId' | 'platform' | 'accountId' | 'landingPageUrl'>;
}

export interface UploadAssetResult {
  creativeId: string;
  result: 'created' | 'updated' | 'duplicate';
  name: string;
  mediaType: string | null;
  sizeBytes: number | null;
  fileStatus: string;
  approvalStatus: string;
  adLink: AdLinkDto | null;
  audit: { before?: unknown; after?: unknown };
}

/** Existing library code throws plain AppErrors; the spec wants coded errors with a next step. */
function toApiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof AppError) {
    const m = err.message;
    if (err.statusCode === 413) {
      throw new ApiError('file_too_large', m, { hint: 'This call takes files up to 50 MB. Larger files need create_upload and complete_upload.' });
    }
    if (/must be an image or video|images or videos/i.test(m)) {
      throw new ApiError('unsupported_type', m, { hint: 'Send a jpg, png, webp or gif image, or an mp4 or mov video.' });
    }
    if (err.statusCode === 422 && /(valid URL|http\(s\)|public address|Could not resolve|Could not download)/i.test(m)) {
      throw new ApiError('source_unreachable', m, { hint: 'sourceUrl must be a public http(s) address that serves the file. Private and internal addresses are blocked.' });
    }
    if (err.statusCode === 502) throw new ApiError('internal_error', m, { retryable: true, hint: 'Nothing was saved. Try again in a few minutes.' });
    if (err.statusCode === 409) throw new ApiError('duplicate', m);
    if (err.statusCode === 404) throw new ApiError('not_found', m);
    throw new ApiError('validation_failed', m);
  }
  throw err;
}

export async function uploadAssetFromUrl(caller: Caller, input: UploadAssetInput): Promise<UploadAssetResult> {
  const hasAccount = Boolean(input.platform && input.platformAccountId);
  if (!hasAccount && !input.clientId) {
    throw new ApiError('validation_failed', 'Send platform and platformAccountId (the account decides the client), or clientId.', {
      fields: [{ field: 'platformAccountId', message: 'Required unless clientId is sent' }],
    });
  }
  if (input.adLink && !hasAccount) {
    throw new ApiError('validation_failed', 'adLink needs platform and platformAccountId.', { fields: [{ field: 'platformAccountId', message: 'Required with adLink' }] });
  }

  // 1. The client: from the ad account when there is one.
  let clientId = input.clientId ?? null;
  let accountDefaultCampaign: string | null = null;
  let stored = '';
  let accountId = '';
  if (hasAccount) {
    stored = normalisePlatform(input.platform!);
    accountId = normaliseAccountId(input.platform!, input.platformAccountId!);
    const [owner] = await db.select().from(clientAdAccounts).where(and(
      eq(clientAdAccounts.businessId, caller.businessId), eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, accountId),
    ));
    if (!owner) throw accountNotLinked(toSpecPlatform(stored), accountId);
    if (input.clientId && input.clientId !== owner.clientId) throw accountClientMismatch(accountId);
    clientId = owner.clientId;
    accountDefaultCampaign = owner.campaignId;
  }
  const [client] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, clientId!), eq(clients.businessId, caller.businessId))).limit(1);
  if (!client) throw new ApiError('not_found', 'That client does not exist in this business.', { hint: 'Use list_clients to find the right clientId.' });

  // 2. The campaign: given and checked, or the account's only one. Several: the caller must choose.
  let campaignId: string | null = null;
  if (input.campaignId) {
    const campaign = await resolveCampaignRef(input.campaignId);
    await assertCampaignBelongsToClient(client.id, campaign.id);
    campaignId = campaign.id;
  } else if (hasAccount) {
    const list = await campaignsForAccount(stored, accountId);
    if (list.length > 1) {
      throw new ApiError('validation_failed', `Account ${accountId} feeds ${list.length} campaigns, so campaignId is required.`, {
        fields: [{ field: 'campaignId', message: 'Required when the account feeds more than one campaign' }],
        details: { campaigns: list },
        hint: 'Choose one campaignId from details.campaigns and send it. Do not guess.',
      });
    }
    campaignId = list[0]?.campaignId ?? accountDefaultCampaign;
  }

  // 3. Create, update or find the duplicate.
  const platform = hasAccount ? toSpecPlatform(stored) : 'manual';
  const platformCreativeId = input.adLink?.platformCreativeId;
  let hadByPlatformId = false;
  if (platformCreativeId && hasAccount) {
    const [prior] = await db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.platform, platform), eq(creatives.platformCreativeId, platformCreativeId)));
    hadByPlatformId = Boolean(prior);
  }
  let up: Awaited<ReturnType<typeof upsertPlatformCreative>>;
  try {
    up = await upsertPlatformCreative({
      businessId: caller.businessId, clientId: client.id, campaignId, platform: platform as 'meta', platformAccountId: hasAccount ? accountId : undefined,
      platformCreativeId, mediaType: input.mediaType, sourceUrl: input.sourceUrl, headline: input.headline, bodyText: input.bodyText,
      landingPageUrl: input.landingPageUrl, name: input.name, uploadedBy: caller.userId,
    });
  } catch (err) {
    toApiError(err);
  }
  const { creative, created } = up;

  // 4. Mark where it came from, merge tags.
  const patch: Partial<typeof creatives.$inferInsert> = {};
  if (created) Object.assign(patch, { source: 'mcp', createdByKeyId: caller.keyId });
  if (input.tags?.length) {
    // Merge with any tags already on the asset (a duplicate or an update keeps its own).
    const incoming = sql`array[${sql.join(input.tags.map((t) => sql`${t}`), sql`, `)}]::text[]`;
    patch.tags = sql`(select coalesce(array_agg(distinct t), '{}'::text[]) from unnest(${creatives.tags} || ${incoming}) as t)` as unknown as string[];
  }
  if (Object.keys(patch).length) await db.update(creatives).set(patch).where(eq(creatives.id, creative.id));

  // 5. Optional ad link in the same call. The asset is kept if the link is refused.
  let adLink: AdLinkDto | null = null;
  if (input.adLink) {
    try {
      const linked = await linkAdPlatformIds({ ...caller, source: 'mcp' }, { ...input.adLink, creativeId: creative.id, platform, accountId, landingPageUrl: input.landingPageUrl });
      adLink = linked.link;
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError(err.code, err.message, {
          hint: `${err.hint ?? ''} The asset itself was saved (creativeId ${creative.id}); repeat only the link with link_ad_platform_ids.`.trim(),
          details: { ...(err.details ?? {}), creativeId: creative.id, assetSaved: true },
        });
      }
      throw err;
    }
  }

  const result: UploadAssetResult['result'] = created ? 'created' : hadByPlatformId ? 'updated' : 'duplicate';
  return {
    creativeId: creative.id,
    result,
    name: creative.name,
    mediaType: creative.type,
    sizeBytes: creative.sizeBytes,
    fileStatus: creative.fileStatus,
    approvalStatus: creative.status,
    adLink,
    audit: { after: { creativeId: creative.id, clientId: client.id, campaignId, result } },
  };
}

export { toAdLinkDto };
