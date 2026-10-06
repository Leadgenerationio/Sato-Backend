import { z } from 'zod';
import { defineTool } from '../tool-contract.js';
import { findClientByAdAccount } from '../../services/creative-ad-links.service.js';

export const tool = defineTool({
  name: 'find_client_by_ad_account',
  title: 'Find the client that owns an ad account',
  description:
    'Call this first, before upload_asset or link_ad_platform_ids, to learn which Stato client owns an ad account and which campaigns it feeds. ' +
    'Matching is on platform + account ID only, never on names. If the account is not linked, the call fails with account_not_linked: stop and ask the user which client and campaign it belongs to, then call link_ad_account. ' +
    'When `campaignRequired` is true the account feeds several campaigns, so send `campaignId` (one of `campaigns`) on the next write; Stato does not guess. ' +
    'All IDs are strings, including Meta and TikTok IDs.',
  scope: 'clients:read',
  annotations: { title: 'Find client by ad account', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    platform: z.string().trim().min(1).max(50)
      .describe('meta, google, tiktok, taboola or bing. Aliases such as facebook-ads or tik-tok are accepted.'),
    accountId: z.string().trim().min(1).max(100)
      .describe('The ad account ID as the platform shows it, as a string. Meta with or without act_, Google with or without dashes.'),
  },
  outputSchema: {
    platform: z.string(),
    accountId: z.string().describe('Stored form: no act_, no dashes.'),
    client: z.object({ clientId: z.string(), name: z.string(), currency: z.string().nullable() }),
    campaign: z.object({ campaignId: z.string(), name: z.string() }).nullable().describe('The campaign set on the account link, if any.'),
    campaigns: z.array(z.object({
      campaignId: z.string(), name: z.string(), leadbyteId: z.string().nullable(), from: z.enum(['account', 'ad_link']),
    })),
    campaignRequired: z.boolean(),
  },
  async handler({ platform, accountId }, ctx) {
    const data = await findClientByAdAccount(ctx.businessId, platform, accountId);
    ctx.audit = { tool: 'find_client_by_ad_account', args: { platform, accountId }, recordsTouched: [{ type: 'client', id: data.client.clientId }] };
    const campaigns = data.campaigns.length === 0
      ? 'no campaign set'
      : data.campaignRequired
        ? `${data.campaigns.length} campaigns (${data.campaigns.map((c) => c.name).join(', ')}): send campaignId`
        : `campaign ${data.campaigns[0]!.name}`;
    return {
      summary: `Ad account ${data.accountId} on ${data.platform} belongs to ${data.client.name}; ${campaigns}.`,
      data: { ...data },
    };
  },
});
