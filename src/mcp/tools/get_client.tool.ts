import { z } from 'zod';
import { defineTool } from '../types.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { getClient } from '../../services/mcp-reads.service.js';

const campaignRef = z.object({ campaignId: z.string(), leadbyteId: z.string().nullable(), name: z.string(), vertical: z.string().nullable(), status: z.string().nullable() });

export default defineTool({
  name: 'get_client',
  title: 'Get one client',
  description: 'One client with its ad accounts, the campaigns it buys, and how many assets and landing pages it has. Use list_clients first to find the clientId. IDs are strings.',
  inputSchema: { clientId: uuidShape().describe('Stato client ID (UUID).') },
  outputSchema: {
    client: z.object({ clientId: z.string(), name: z.string(), status: z.string().nullable(), currency: z.string().nullable(), country: z.string().nullable() }),
    adAccounts: z.array(z.object({ platform: z.string(), accountId: z.string(), accountName: z.string().nullable(), campaignId: z.string().nullable(), campaignName: z.string().nullable() })),
    campaigns: z.array(campaignRef),
    creativeCount: z.number(),
    landingPageCount: z.number(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'clients:read',
  handler: async ({ clientId }, ctx) => {
    const d = await getClient(ctx.businessId, clientId);
    return { summary: `${d.client.name}: ${d.adAccounts.length} ad accounts, ${d.campaigns.length} campaigns, ${d.creativeCount} assets.`, data: d };
  },
});
