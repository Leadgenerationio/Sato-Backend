import { z } from 'zod';
import { defineTool } from '../types.js';
import { adLinkOut } from '../schemas.js';
import { linkAdPlatformIds } from '../../services/creative-ad-links.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';

export default defineTool({
  name: 'link_ad_platform_ids',
  title: 'Record the ad an asset runs in',
  description:
    'Record that an asset in Stato runs in a platform ad, after you created the ad with your ad-platform tools. Send the IDs the platform returned. ' +
    'Stato checks the ad account really belongs to the asset\'s client and saves nothing if not (account_client_mismatch, or account_not_linked: stop and ask the owner). ' +
    'Send at least one of adId, platformCreativeId or platformAssetId. All IDs are strings, exactly as the platform shows them (Meta account with or without act_). ' +
    'Safe to repeat: the same ad returns unchanged. An ad already linked to a different asset returns result = duplicate with that link\'s IDs and saves nothing (it is not an error; use unlink_ad_platform_ids first if the ad really changed asset). ' +
    'If the ad account feeds several campaigns and the asset has none, send campaignId (the Stato campaign) or the call fails with validation_failed listing them.',
  inputSchema: {
    creativeId: uuidShape().describe('Stato asset ID (UUID).'),
    platform: z.string().min(1).max(50).describe('meta, google, tiktok or taboola.'),
    accountId: z.string().min(1).max(100).describe('The ad account ID the ad lives in.'),
    campaignId: z.string().max(100).optional().describe('The STATO campaign (UUID, or the LeadByte number). Needed only when the ad account feeds several campaigns and the asset has none.'),
    platformCampaignId: z.string().max(100).optional().describe('The ad platform\'s own campaign ID.'),
    platformCampaignName: z.string().max(255).optional(),
    adsetId: z.string().max(100).optional().describe('Meta ad set, Google ad group or Performance Max asset group, TikTok ad group. Taboola has none.'),
    adsetName: z.string().max(255).optional(),
    adId: z.string().max(100).optional(),
    adName: z.string().max(255).optional(),
    platformCreativeId: z.string().max(100).optional(),
    platformAssetId: z.string().max(255).optional().describe('Meta image hash or video ID, Google asset resource name, TikTok video or image ID.'),
    landingPageUrl: z.string().max(2000).optional(),
    status: z.enum(['active', 'paused', 'unknown']).optional().describe('Left out: active on a new link, unchanged on a repeat.'),
  },
  outputSchema: { adLinkId: z.string(), result: z.enum(['created', 'unchanged', 'updated', 'duplicate']), adLink: adLinkOut },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'ad_links:write',
  handler: async (args, ctx) => {
    const res = await linkAdPlatformIds(
      { businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id, source: 'mcp' },
      args as Parameters<typeof linkAdPlatformIds>[1],
    );
    if (res.result === 'duplicate') {
      return {
        summary: `That ${res.link.platform} ad is already linked to asset ${res.link.creativeId}; nothing was saved. Unlink it first if the ad changed asset.`,
        data: { adLinkId: res.link.adLinkId, result: res.result, adLink: res.link },
        audit: { before: res.before ?? undefined, recordsTouched: [] },
      };
    }
    return {
      summary: `Ad link ${res.result} for asset ${res.link.creativeId} on ${res.link.platform}.`,
      data: { adLinkId: res.link.adLinkId, result: res.result, adLink: res.link },
      audit: { before: res.before ?? undefined, after: res.link, recordsTouched: [{ type: 'ad_link', id: res.link.adLinkId }, { type: 'creative', id: res.link.creativeId }] },
    };
  },
});
