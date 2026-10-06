import { z } from 'zod';
import { defineTool } from '../types.js';
import { listAdAccounts } from '../../services/ad-account-links.service.js';
import { toSpecPlatform } from '../../utils/platform-names.js';
import { ApiError } from '../../utils/api-error.js';

export default defineTool({
  name: 'list_ad_accounts',
  title: 'Find ad accounts',
  description:
    'Ad accounts with their last-30-day spend and what they are linked to. Use linked = false to find accounts that have spend but no client (then ask the owner and call link_ad_account). ' +
    'Use campaignId or clientId to find the right ad account for a campaign (Workflow B). Filters are combined. Results are paged: pass nextCursor back. IDs are strings.',
  inputSchema: {
    platform: z.string().max(50).optional().describe('meta, google, tiktok or taboola.'),
    clientId: z.string().optional(),
    campaignId: z.string().optional().describe('Stato campaign UUID.'),
    linked: z.boolean().optional().describe('true = linked to a client, false = not linked yet.'),
    q: z.string().max(100).optional().describe('Part of the account ID (with or without act_) or the account name.'),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
  },
  outputSchema: {
    items: z.array(z.object({
      platform: z.string(), accountId: z.string(), accountName: z.string().nullable(), clientId: z.string().nullable(), clientName: z.string().nullable(),
      campaignId: z.string().nullable(), campaignName: z.string().nullable(), campaigns: z.array(z.object({ campaignId: z.string(), campaignName: z.string() })),
      spend30d: z.number(), currency: z.string().nullable(),
    })),
    nextCursor: z.string().nullable(),
    summary: z.object({ total: z.number(), linked: z.number(), unlinked: z.number() }),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'ad_accounts:read',
  handler: async ({ limit, cursor, ...filters }, ctx) => {
    let offset = 0;
    if (cursor) {
      try { offset = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: number }).o; if (!Number.isInteger(offset) || offset < 0) throw new Error('bad'); }
      catch { throw new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] }); }
    }
    const size = limit ?? 100;
    const all = await listAdAccounts(ctx.auth, 30, { ...filters, businessOnly: true });
    const page = all.accounts.slice(offset, offset + size);
    return {
      summary: `${all.summary.total} ad accounts (${all.summary.linked} linked, ${all.summary.unlinked} not linked); showing ${page.length}.`,
      data: {
        items: page.map((a) => ({
          platform: toSpecPlatform(a.platform), accountId: a.accountId, accountName: a.accountName, clientId: a.link?.clientId ?? null, clientName: a.link?.clientName ?? null,
          campaignId: a.link?.campaignId ?? null, campaignName: a.link?.campaignName ?? null, campaigns: a.campaigns, spend30d: a.spend, currency: a.currency,
        })),
        nextCursor: offset + size < all.accounts.length ? Buffer.from(JSON.stringify({ o: offset + size })).toString('base64url') : null,
        summary: { total: all.summary.total, linked: all.summary.linked, unlinked: all.summary.unlinked },
      },
    };
  },
});
