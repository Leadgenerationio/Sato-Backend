import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { clients } from '../db/schema/clients.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { toApiError } from '../utils/to-api-error.js';
import { upsertCopyCreative } from './creative-copy.service.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { startUrlUpload } from './mcp-url-uploads.service.js';
import { ApiError, accountClientMismatch, accountNotLinked } from '../utils/api-error.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { upsertPlatformCreative } from './creative-library.service.js';
import { assertCampaignBelongsToClient, campaignsForAccount, resolveCampaignRef, type Caller } from './ad-account-rules.service.js';
import { linkAdPlatformIds, toAdLinkDto, type AdLinkDto, type AdLinkInput } from './creative-ad-links.service.js';
import { claimUploadForFiling, getReadyUpload, linkUploadToCreative, releaseUploadClaim } from './mcp-uploads.service.js';

// MCP spec v1.0 upload_asset for a file that arrives as a sourceUrl (up to 50 MB)
// or as a finished direct upload (uploadId, up to 4 GB). The ad account decides
// the client; clientId is only a cross-check.

export interface UploadAssetInput {
  /** Optional with uploadId (the real type comes from the file); must match it when sent. */
  /** 'copy' = a copy-only asset: ad copy (headline and/or bodyText) with no file. */
  mediaType?: 'image' | 'video' | 'copy';
  name?: string;
  /** Exactly one of sourceUrl or uploadId (a copy-only asset sends neither). */
  sourceUrl?: string;
  uploadId?: string;
  clientId?: string;
  platform?: string;
  platformAccountId?: string;
  campaignId?: string;
  headline?: string;
  bodyText?: string;
  landingPageUrl?: string;
  tags?: string[];
  /** The ad's own IDs. The Stato campaign is the top-level campaignId, not repeated here. */
  adLink?: Omit<AdLinkInput, 'creativeId' | 'platform' | 'accountId' | 'landingPageUrl' | 'campaignId'>;
}

export interface UploadAssetResult {
  creativeId: string;
  result: 'created' | 'updated' | 'duplicate';
  name: string;
  mediaType: string | null;
  sizeBytes: number | null;
  fileStatus: string;
  approvalStatus: string;
  /** The asset in the Stato portal. */
  portalUrl: string;
  adLink: AdLinkDto | null;
  /** What happened to the ad link; duplicate = the ad already runs another asset (the asset itself is saved). */
  adLinkResult: 'created' | 'updated' | 'unchanged' | 'duplicate' | null;
  audit: { before?: unknown; after?: unknown };
}

export async function uploadAssetFromUrl(caller: Caller, input: UploadAssetInput): Promise<UploadAssetResult> {
  const isCopy = input.mediaType === 'copy';
  if (isCopy) {
    if (input.sourceUrl || input.uploadId) {
      throw new ApiError('validation_failed', 'A copy-only asset (mediaType copy) has no file: send neither sourceUrl nor uploadId.', { fields: [{ field: input.sourceUrl ? 'sourceUrl' : 'uploadId', message: 'Leave out for mediaType copy' }] });
    }
    if (!input.headline?.trim() && !input.bodyText?.trim()) {
      throw new ApiError('validation_failed', 'A copy-only asset needs a headline or bodyText.', { fields: [{ field: 'headline', message: 'Send headline and/or bodyText' }] });
    }
  } else if (Boolean(input.sourceUrl) === Boolean(input.uploadId)) {
    throw new ApiError('validation_failed', 'Send exactly one of sourceUrl or uploadId.', {
      fields: [{ field: input.sourceUrl ? 'uploadId' : 'sourceUrl', message: 'Send either sourceUrl (a public file up to 50 MB) or uploadId (from create_upload and complete_upload)' }],
    });
  }
  if (!input.uploadId && !input.mediaType) {
    throw new ApiError('validation_failed', 'mediaType is required with sourceUrl.', { fields: [{ field: 'mediaType', message: 'image or video' }] });
  }
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
    const campaign = await resolveCampaignRef(input.campaignId, caller.businessId);
    await assertCampaignBelongsToClient(client.id, campaign.id);
    campaignId = campaign.id;
  } else if (hasAccount) {
    const list = await campaignsForAccount(stored, accountId, caller.businessId);
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
  // A finished direct upload: its real size, type and SHA-256 were checked by complete_upload.
  let uploadRow: Awaited<ReturnType<typeof getReadyUpload>> | null = null;
  let replayOf: typeof creatives.$inferSelect | null = null;
  let verified: NonNullable<Parameters<typeof upsertPlatformCreative>[0]['verified']> | undefined;
  if (input.uploadId) {
    uploadRow = await getReadyUpload(caller, input.uploadId);
    if (uploadRow.creativeId) {
      // Already used. The same client asking again gets the first asset back; any other use is refused, so the file of
      // one asset can never be pointed at a second one (or deleted as a duplicate under it).
      const [first] = await db.select().from(creatives).where(eq(creatives.id, uploadRow.creativeId));
      if (!first || first.clientId !== client.id) {
        throw new ApiError('validation_failed', 'This upload was already used for another asset.', {
          fields: [{ field: 'uploadId', message: 'Already used' }], hint: 'Start again with create_upload for a new file.',
        });
      }
      replayOf = first;
    }
    const family = (uploadRow.contentType ?? '').split('/')[0] as 'image' | 'video';
    if (input.mediaType && input.mediaType !== family) {
      throw new ApiError('validation_failed', `mediaType is ${input.mediaType} but the uploaded file is a ${family}.`, { fields: [{ field: 'mediaType', message: `The file is a ${family}` }] });
    }
    verified = { sha256: uploadRow.sha256!, sizeBytes: Number(uploadRow.sizeBytes), contentType: uploadRow.contentType!, mediaType: family, fileStatus: family === 'video' ? 'processing' : 'ready' };
  }
  let up: Awaited<ReturnType<typeof upsertPlatformCreative>>;
  // Claimed in the database, so it holds across API instances too.
  const lockId = replayOf ? null : uploadRow?.id ?? null;
  if (lockId && !(await claimUploadForFiling(lockId))) {
    throw new ApiError('rate_limited', 'This upload is being filed by another call, or was just used.', { retryable: true, details: { retryAfter: 2 }, hint: 'Wait a few seconds, then repeat the same call with the same arguments.' });
  }
  try {
    if (replayOf) up = { creative: replayOf, created: false } as Awaited<ReturnType<typeof upsertPlatformCreative>>;
    else if (isCopy) up = await upsertCopyCreative({
      businessId: caller.businessId, clientId: client.id, campaignId, platform, platformAccountId: hasAccount ? accountId : undefined, platformCreativeId,
      headline: input.headline, bodyText: input.bodyText, landingPageUrl: input.landingPageUrl, name: input.name, uploadedBy: caller.userId,
    });
    else up = await upsertPlatformCreative({
      businessId: caller.businessId, clientId: client.id, campaignId, platform: platform as 'meta', platformAccountId: hasAccount ? accountId : undefined,
      platformCreativeId, mediaType: verified?.mediaType ?? (input.mediaType as 'image' | 'video'), sourceUrl: input.sourceUrl, r2Key: uploadRow?.r2Key, verified, headline: input.headline, bodyText: input.bodyText,
      landingPageUrl: input.landingPageUrl, name: input.name, uploadedBy: caller.userId,
    });
    if (uploadRow && !replayOf) await linkUploadToCreative(uploadRow.id, up.creative.id);
  } catch (err) {
    // A sourceUrl bigger than the 50 MB direct limit: copy it in the background (up to 1 GB) and tell the caller to poll.
    if (input.sourceUrl && err instanceof AppError && err.statusCode === 413) {
      const started = await startUrlUpload(caller, input.sourceUrl);
      throw new ApiError('upload_incomplete', 'This file is bigger than 50 MB, so Stato is copying it from the URL in the background.', {
        retryable: true,
        hint: 'Call complete_upload with details.uploadId until status is ready, then call upload_asset again with that uploadId (instead of sourceUrl) and the same platform, account and name.',
        details: { uploadId: started.uploadId, reused: started.reused, retryAfter: 10 },
      });
    }
    toApiError(err);
  } finally {
    if (lockId) await releaseUploadClaim(lockId).catch(() => {});
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
  let adLinkResult: UploadAssetResult['adLinkResult'] = null;
  if (input.adLink) {
    try {
      const linked = await linkAdPlatformIds({ ...caller, source: 'mcp' }, { ...input.adLink, creativeId: creative.id, platform, accountId, campaignId: campaignId ?? undefined, landingPageUrl: input.landingPageUrl });
      adLink = linked.link;
      adLinkResult = linked.result;
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
    portalUrl: `${env.FRONTEND_URL.replace(/\/$/, '')}/creatives?creative=${creative.id}`,
    adLink,
    adLinkResult,
    audit: { after: { creativeId: creative.id, clientId: client.id, campaignId, result } },
  };
}

export { toAdLinkDto };
