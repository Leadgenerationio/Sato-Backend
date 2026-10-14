import { z } from 'zod';
import { defineTool } from '../types.js';
import { listAdAccounts, adAccountSortKey, compareAdAccountSortKey, type AdAccountSortKey } from '../../services/ad-account-links.service.js';
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
    // Keyset by the account's place in the list (unlinked first, then spend, then platform+accountId): the cursor is
    // the sort position of the last account sent, so the next page resumes right after it. Unlike a row offset, an
    // account added, removed or linked between pages can't make the next page skip or repeat one.
    let after: AdAccountSortKey | null = null;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<AdAccountSortKey>;
        if (typeof c.linked !== 'boolean' || typeof c.spend !== 'number' || typeof c.platform !== 'string' || typeof c.accountId !== 'string') throw new Error('bad');
        after = c as AdAccountSortKey;
      } catch { throw new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] }); }
    }
    const size = limit ?? 100;
    const all = await listAdAccounts(ctx.auth, 30, { ...filters, businessOnly: true });
    // The first account that sorts strictly after the cursor. findIndex returns -1 when none remain (cursor was the
    // last row, or every later row is gone) — then the page is empty and there is no next cursor.
    const startIdx = after ? all.accounts.findIndex((a) => compareAdAccountSortKey(after!, adAccountSortKey(a)) < 0) : 0;
    const page = startIdx < 0 ? [] : all.accounts.slice(startIdx, startIdx + size);
    const last = page[page.length - 1];
    const hasMore = startIdx >= 0 && startIdx + size < all.accounts.length;
    return {
      summary: `${all.summary.total} ad accounts (${all.summary.linked} linked, ${all.summary.unlinked} not linked); showing ${page.length}.`,
      data: {
        items: page.map((a) => ({
          platform: toSpecPlatform(a.platform), accountId: a.accountId, accountName: a.accountName, clientId: a.link?.clientId ?? null, clientName: a.link?.clientName ?? null,
          campaignId: a.link?.campaignId ?? null, campaignName: a.link?.campaignName ?? null, campaigns: a.campaigns, spend30d: a.spend, currency: a.currency,
        })),
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify(adAccountSortKey(last))).toString('base64url') : null,
        summary: { total: all.summary.total, linked: all.summary.linked, unlinked: all.summary.unlinked },
      },
    };
  },
});
