import { z } from 'zod';
import { defineTool } from '../types.js';
import { listAssets } from '../../services/mcp-assets.service.js';

export default defineTool({
  name: 'list_assets',
  title: 'Find assets',
  description:
    'Search the assets (images, videos, copy) in Stato. Use it to find an asset to use in an ad (Workflow B), for example by campaign, approvalStatus and hasAdLink = false. ' +
    'Archived assets are hidden unless includeArchived is true. Results are paged: pass nextCursor back. Then call get_asset for a download link. IDs are strings.',
  inputSchema: {
    clientId: z.string().optional(), campaignId: z.string().optional(),
    platform: z.string().max(50).optional().describe('meta, google, tiktok or taboola.'),
    platformAccountId: z.string().max(100).optional(), platformAdId: z.string().max(100).optional(), landingPageId: z.string().optional(),
    mediaType: z.enum(['image', 'video', 'copy']).optional(),
    approvalStatus: z.enum(['draft', 'sent_for_approval', 'approved', 'rejected', 'changes_requested']).optional(),
    hasAdLink: z.boolean().optional().describe('false = not yet linked to any platform ad.'),
    q: z.string().max(100).optional().describe('Part of the name, headline, body text or an ad ID.'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Created on or after, YYYY-MM-DD.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Created on or before, YYYY-MM-DD.'),
    includeArchived: z.boolean().optional(),
    sort: z.enum(['created', 'name']).optional(),
    limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional(),
  },
  outputSchema: {
    items: z.array(z.object({
      creativeId: z.string(), name: z.string(), mediaType: z.string().nullable(), thumbnailUrl: z.string().nullable(),
      client: z.object({ clientId: z.string(), name: z.string() }).nullable(), campaign: z.object({ campaignId: z.string(), name: z.string() }).nullable(),
      approvalStatus: z.string(), fileStatus: z.string(), adLinkCount: z.number(), archivedAt: z.string().nullable(), createdAt: z.string().nullable(),
    })),
    nextCursor: z.string().nullable(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'creatives:read',
  handler: async (args, ctx) => {
    const page = await listAssets(ctx.businessId, args);
    return { summary: `${page.items.length} assets${page.nextCursor ? ' (more on the next page)' : ''}.`, data: page };
  },
});
