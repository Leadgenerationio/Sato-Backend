import { z } from 'zod';
import { defineTool } from '../types.js';
import { adLinkOut } from '../schemas.js';
import { linkAdPlatformIds } from '../../services/creative-ad-links.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';


export default defineTool({
  name: 'link_ad_platform_ids',
  title: 'Record the ad an asset runs in',
  description:
    'Record that an asset in Stato runs in a platform ad, after you created the ad with your ad-platform tools. Send the IDs the platform returned. ' +
    'Stato checks the ad account really belongs to the asset\'s client and saves nothing if not (account_client_mismatch, or account_not_linked: stop and ask the owner). ' +
    'Send at least one of adId, platformCreativeId or platformAssetId. All IDs are strings, exactly as the platform shows them (Meta account with or without act_). ' +
    'Safe to repeat: the same ad returns unchanged. An ad already linked to a different asset returns the error duplicate with that link\'s ID.',
  inputSchema: {
    creativeId: z.string().min(1).describe('Stato asset ID (UUID).'),
    platform: z.string().min(1).max(50).describe('meta, google, tiktok or taboola.'),
    accountId: z.string().min(1).max(100).describe('The ad account ID the ad lives in.'),
    campaignId: z.string().max(100).optional().describe('The PLATFORM campaign ID (not the Stato campaign).'),
    campaignName: z.string().max(255).optional(),
    adsetId: z.string().max(100).optional().describe('Meta ad set, Google ad group or Performance Max asset group, TikTok ad group. Taboola has none.'),
    adsetName: z.string().max(255).optional(),
    adId: z.string().max(100).optional(),
    adName: z.string().max(255).optional(),
    platformCreativeId: z.string().max(100).optional(),
    platformAssetId: z.string().max(255).optional().describe('Meta image hash or video ID, Google asset resource name, TikTok video or image ID.'),
    landingPageUrl: z.string().max(2000).optional(),
    status: z.enum(['active', 'paused', 'removed', 'unknown']).optional(),
  },
  outputSchema: { adLinkId: z.string(), result: z.enum(['created', 'unchanged', 'updated']), adLink: adLinkOut },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'creatives:write',
  handler: async (args, ctx) => {
    const res = await linkAdPlatformIds(
      { businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id, source: 'mcp' },
      args as Parameters<typeof linkAdPlatformIds>[1],
    );
    return {
      summary: `Ad link ${res.result} for asset ${res.link.creativeId} on ${res.link.platform}.`,
      data: { adLinkId: res.link.adLinkId, result: res.result, adLink: res.link },
      audit: { before: res.before ?? undefined, after: res.link, recordsTouched: [{ type: 'ad_link', id: res.link.adLinkId }, { type: 'creative', id: res.link.creativeId }] },
    };
  },
});
