import { z } from 'zod';
import { defineTool } from '../types.js';
import { findAccountOwner } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'find_client_by_ad_account',
  title: 'Find client by ad account',
  description:
    'Which Stato client owns an ad account. Call this first, before upload_asset or link_ad_platform_ids, to learn the client and the campaigns. ' +
    'If the account feeds more than one campaign, campaignRequired is true and you must send campaignId on later calls: never guess. ' +
    'If the account is not linked you get the error account_not_linked: stop and ask the owner. IDs are strings, exactly as the platform shows them (Meta with or without act_).',
  inputSchema: {
    platform: z.string().min(1).max(50).describe('meta, google, tiktok or taboola. Aliases such as facebook-ads are accepted.'),
    accountId: z.string().min(1).max(100).describe('The platform ad account ID as a string. Never an account name.'),
  },
  outputSchema: {
    platform: z.string(),
    accountId: z.string(),
    client: z.object({ id: z.string(), name: z.string(), currency: z.string().nullable() }),
    campaign: z.object({ id: z.string(), name: z.string() }).nullable(),
    campaigns: z.array(z.object({ campaignId: z.string(), name: z.string() })),
    campaignRequired: z.boolean(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'clients:read',
  handler: async ({ platform, accountId }, ctx) => {
    const owner = await findAccountOwner(ctx.businessId, platform, accountId);
    const note = owner.campaignRequired ? ` It feeds ${owner.campaigns.length} campaigns, so send campaignId.` : '';
    return { summary: `Account ${owner.accountId} on ${owner.platform} belongs to ${owner.client.name}.${note}`, data: owner };
  },
});
