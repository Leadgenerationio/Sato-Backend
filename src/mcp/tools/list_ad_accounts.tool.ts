import { z } from 'zod';
import { defineTool } from '../types.js';
import { listAdAccounts, type AdAccountRow } from '../../services/ad-account-links.service.js';
import { toSpecPlatform } from '../../utils/platform-names.js';
import { decodeCursor, encodeCursor, CURSOR_MAX_LEN } from '../../utils/cursor.js';

// Every campaign the account feeds: the one it is linked to (link_ad_account's campaignId) first, then the campaigns whose
// LeadByte traffic sources list it, without repeats. Before, only the traffic-source ones were listed, so an account linked
// with a campaign showed campaignName filled but campaigns empty (Sam, staging test 15 Oct).
function campaignsOf(a: AdAccountRow): Array<{ campaignId: string; campaignName: string }> {
  const out: Array<{ campaignId: string; campaignName: string }> = [];
  if (a.link?.campaignId && a.link.campaignName) out.push({ campaignId: a.link.campaignId, campaignName: a.link.campaignName });
  for (const c of a.campaigns) if (!out.some((o) => o.campaignId === c.campaignId)) out.push(c);
  return out;
}

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
    cursor: z.string().max(CURSOR_MAX_LEN).optional(),
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
    // Page by the account's stable identity (platform, accountId) — immutable per account — so linking an account or a
    // 30-day-spend change between pages can't move a row across the cursor and make the page skip or repeat it. (The
    // portal screen keeps the unlinked-first/spend order; a bot wanting that can sort client-side on spend30d.)
    const after = decodeCursor(cursor, (raw) => {
      const c = raw as { p?: unknown; a?: unknown };
      return typeof c.p === 'string' && typeof c.a === 'string' ? { p: c.p, a: c.a } : null;
    });
    const size = limit ?? 100;
    const all = await listAdAccounts(ctx.auth, 30, { ...filters, businessOnly: true });
    const sorted = [...all.accounts].sort((x, y) => x.platform.localeCompare(y.platform) || x.accountId.localeCompare(y.accountId));
    // The first account that sorts strictly after the cursor. findIndex returns -1 when none remain (cursor was the
    // last row, or every later row is gone) — then the page is empty and there is no next cursor. A deleted cursor
    // account is handled too: we resume at the next (platform, accountId), not restart.
    const startIdx = after ? sorted.findIndex((a) => (a.platform.localeCompare(after.p) || a.accountId.localeCompare(after.a)) > 0) : 0;
    const page = startIdx < 0 ? [] : sorted.slice(startIdx, startIdx + size);
    const last = page[page.length - 1];
    const hasMore = startIdx >= 0 && startIdx + size < sorted.length;
    return {
      summary: `${all.summary.total} ad accounts (${all.summary.linked} linked, ${all.summary.unlinked} not linked); showing ${page.length}.`,
      data: {
        items: page.map((a) => ({
          platform: toSpecPlatform(a.platform), accountId: a.accountId, accountName: a.accountName, clientId: a.link?.clientId ?? null, clientName: a.link?.clientName ?? null,
          campaignId: a.link?.campaignId ?? null, campaignName: a.link?.campaignName ?? null, campaigns: campaignsOf(a), spend30d: a.spend, currency: a.currency,
        })),
        nextCursor: hasMore && last ? encodeCursor({ p: last.platform, a: last.accountId }) : null,
        summary: { total: all.summary.total, linked: all.summary.linked, unlinked: all.summary.unlinked },
      },
    };
  },
});
