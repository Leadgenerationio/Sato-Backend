import { z } from 'zod';
import { defineTool } from '../types.js';
import { linkAdAccount, realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'link_ad_account',
  title: 'Link ad account to client',
  description:
    'Record which client (and optionally which campaign) an ad account belongs to. Use it only when the owner has told you. ' +
    'If the account is already linked to a different client the call fails with move_requires_confirm; ask the owner, then repeat with confirmMove = true. ' +
    'campaignId must be a campaign this client buys (the Stato UUID, or the LeadByte number). Safe to repeat: the same link returns unchanged. IDs are strings.',
  inputSchema: {
    clientId: z.string().min(1).describe('Stato client ID (UUID), from list_clients.'),
    platform: z.string().min(1).max(50).describe('meta, google, tiktok or taboola. Aliases are accepted.'),
    accountId: z.string().min(1).max(100).describe('The platform ad account ID as a string (Meta with or without act_, Google with or without dashes).'),
    campaignId: z.string().min(1).max(100).optional().describe('Stato campaign UUID, or the LeadByte campaign number.'),
    accountName: z.string().max(255).optional(),
    currency: z.string().length(3).optional(),
    confirmMove: z.boolean().optional().describe('Set true only after the owner agreed to move an account from another client.'),
  },
  outputSchema: {
    result: z.enum(['created', 'updated', 'unchanged', 'moved']),
    link: z.object({
      platform: z.string(), accountId: z.string(), clientId: z.string(), clientName: z.string(),
      campaignId: z.string().nullable(), campaignName: z.string().nullable(), movedFromClientId: z.string().nullable(), movedAt: z.string().nullable(),
    }),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'ad_accounts:write',
  handler: async (args, ctx) => {
    const res = await linkAdAccount(
      { businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id },
      args as Parameters<typeof linkAdAccount>[1],
    );
    return {
      summary: `Ad account ${res.link.accountId} on ${res.link.platform}: ${res.result} for ${res.link.clientName}.`,
      data: { result: res.result, link: res.link },
      audit: {
        before: res.before ?? undefined,
        after: { clientId: res.link.clientId, campaignId: res.link.campaignId },
        recordsTouched: [{ type: 'ad_account_link', id: `${res.link.platform}:${res.link.accountId}` }],
      },
    };
  },
});
