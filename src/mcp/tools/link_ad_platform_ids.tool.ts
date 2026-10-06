import { z } from 'zod';
import { defineTool } from '../tool-contract.js';
import { linkAdPlatformIds } from '../../services/creative-ad-links.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';

const id = (what: string) => z.string().trim().min(1).max(100).optional().describe(`${what}, as a string.`);

export const tool = defineTool({
  name: 'link_ad_platform_ids',
  title: 'Record the platform ad a creative runs in',
  description:
    'Record that a Stato creative runs in a platform ad, after you created or edited the ad through Pipeboard. Stato only records the IDs; it never changes the ad. ' +
    'The ad account must already be linked to the same client as the creative (find_client_by_ad_account checks this). If it belongs to another client the call fails with account_client_mismatch and nothing is saved. ' +
    'Send the ad ID whenever there is one. Calling again with the same IDs is safe: it answers unchanged or updated, and an ad that already runs another creative answers duplicate with that creative\'s ID (call unlink_ad_platform_ids first if the ad really changed creative). ' +
    'If the account feeds several campaigns and the creative has none, send campaignId. All IDs are strings.',
  scope: 'ad_links:write',
  annotations: { title: 'Link ad platform IDs', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    creativeId: uuidShape().describe('Stato creative ID (from upload_asset or list_assets).'),
    platform: z.string().trim().min(1).max(50).describe('meta, google, tiktok or taboola.'),
    accountId: z.string().trim().min(1).max(100).describe('The ad account the ad lives in. Meta with or without act_, Google with or without dashes.'),
    campaignId: z.string().trim().min(1).max(100).optional()
      .describe("Stato campaign ID (UUID) or its LeadByte number. Leave out to use the creative's campaign, then the ad account's."),
    platformCampaignId: id('Platform campaign ID'),
    platformCampaignName: z.string().trim().max(255).optional(),
    platformAdsetId: id('Meta ad set, Google ad group (or Performance Max asset group) or TikTok ad group ID'),
    platformAdsetName: z.string().trim().max(255).optional(),
    platformAdId: id('Platform ad ID'),
    platformAdName: z.string().trim().max(255).optional(),
    platformCreativeId: id('Platform creative ID'),
    platformAssetId: z.string().trim().min(1).max(255).optional()
      .describe('Meta image hash or video ID, Google asset resource name, or TikTok video or image ID.'),
    landingPageUrl: z.string().trim().min(1).max(500).optional().describe("The ad's landing page. Stored once per client; tracking parameters are ignored."),
    status: z.enum(['active', 'paused', 'unknown']).optional().describe('The ad status on the platform. Default active.'),
  },
  outputSchema: {
    result: z.enum(['created', 'updated', 'unchanged', 'duplicate']),
    adLinkId: z.string(),
    creativeId: z.string().describe('For duplicate: the creative that already runs in this ad.'),
    adLink: z.record(z.string(), z.unknown()),
  },
  async handler(args, ctx) {
    const out = await linkAdPlatformIds(
      { businessId: ctx.businessId, userId: ctx.apiKey ? null : ctx.user.userId, apiKeyId: ctx.apiKey?.id ?? null, source: 'mcp' },
      args,
    );
    ctx.audit = {
      tool: 'link_ad_platform_ids',
      args: { ...args },
      before: out.before,
      after: out.after,
      recordsTouched: out.result === 'duplicate' || out.result === 'unchanged'
        ? []
        : [{ type: 'creative_ad_link', id: out.adLink.adLinkId }, { type: 'creative', id: out.adLink.creativeId }],
    };
    const ad = out.adLink.platformAdId ? `ad ${out.adLink.platformAdId}` : `platform creative ${out.adLink.platformCreativeId ?? out.adLink.platformAssetId}`;
    const summary = {
      created: `Linked creative ${out.adLink.creativeId} to ${out.adLink.platform} ${ad}.`,
      updated: `Updated the link between creative ${out.adLink.creativeId} and ${out.adLink.platform} ${ad}.`,
      unchanged: `Creative ${out.adLink.creativeId} was already linked to ${out.adLink.platform} ${ad}; nothing changed.`,
      duplicate: `${out.adLink.platform} ${ad} already runs creative ${out.existingCreativeId}; nothing was saved. Unlink it first if the ad changed creative.`,
    }[out.result];
    return {
      summary,
      data: { result: out.result, adLinkId: out.adLink.adLinkId, creativeId: out.adLink.creativeId, adLink: { ...out.adLink } },
    };
  },
});
