import { z } from 'zod';
import { defineTool } from '../types.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { listCampaignsForMcp } from '../../services/mcp-reads.service.js';

export default defineTool({
  name: 'list_campaigns',
  title: 'Find campaigns',
  description:
    'List or search campaigns, optionally only those one client buys (clientId). Each has a Stato campaignId (a UUID, the one to use everywhere) and the LeadByte number as leadbyteId. ' +
    'Results are paged: pass nextCursor back. IDs are strings.',
  inputSchema: {
    clientId: uuidShape().optional().describe('Only campaigns this client buys.'),
    status: z.string().max(30).optional(),
    vertical: z.string().max(100).optional(),
    q: z.string().max(100).optional().describe('Part of the name, or the exact LeadByte number.'),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(200).optional(),
  },
  outputSchema: {
    items: z.array(z.object({
      campaignId: z.string(), leadbyteId: z.string().nullable(), name: z.string(), vertical: z.string().nullable(), status: z.string().nullable(),
      currency: z.string().nullable(), linkedClientIds: z.array(z.string()),
    })),
    nextCursor: z.string().nullable(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'campaigns:read',
  handler: async (args, ctx) => {
    const page = await listCampaignsForMcp(ctx.businessId, args);
    return { summary: `${page.items.length} campaigns${page.nextCursor ? ' (more on the next page)' : ''}.`, data: page };
  },
});
