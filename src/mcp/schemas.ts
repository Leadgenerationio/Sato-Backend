import { z } from 'zod';

// Output shapes shared by more than one tool.
export const adLinkOut = z.object({
  adLinkId: z.string(), creativeId: z.string(), clientId: z.string().nullable(), campaignId: z.string().nullable(), platform: z.string(),
  accountId: z.string().nullable(), platformCampaignId: z.string().nullable(), platformCampaignName: z.string().nullable(),
  adsetId: z.string().nullable(), adsetName: z.string().nullable(), adId: z.string().nullable(), adName: z.string().nullable(),
  platformCreativeId: z.string().nullable(), platformAssetId: z.string().nullable(), landingPageId: z.string().nullable(),
  status: z.enum(['active', 'paused', 'removed', 'unknown']), source: z.string(), createdAt: z.string(), removedAt: z.string().nullable(),
});
