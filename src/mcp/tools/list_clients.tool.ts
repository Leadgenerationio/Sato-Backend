import { z } from 'zod';
import { defineTool } from '../types.js';
import { listClients } from '../../services/mcp-reads.service.js';
import { clientStatusEnum } from '../../db/schema/clients.js';

export default defineTool({
  name: 'list_clients',
  title: 'Find clients',
  description:
    'List or search the clients in this business. Use it to find a clientId before link_ad_account, get_client or list_campaigns. Results are paged: pass nextCursor back to get the next page. IDs are strings.',
  inputSchema: {
    q: z.string().max(100).optional().describe('Part of the company name.'),
    status: z.enum(clientStatusEnum.enumValues).optional().describe('Client status.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size, default 25, at most 100.'),
    cursor: z.string().max(200).optional().describe('The nextCursor from the previous page.'),
  },
  outputSchema: {
    items: z.array(z.object({ clientId: z.string(), name: z.string(), status: z.string().nullable(), currency: z.string().nullable(), country: z.string().nullable(), adAccountCount: z.number() })),
    nextCursor: z.string().nullable(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'clients:read',
  handler: async (args, ctx) => {
    const page = await listClients(ctx.businessId, args);
    return { summary: `${page.items.length} clients${page.nextCursor ? ' (more on the next page)' : ''}.`, data: page };
  },
});
