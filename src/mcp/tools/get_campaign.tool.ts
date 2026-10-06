import { z } from 'zod';
import { defineTool } from '../types.js';
import { getCampaignForMcp } from '../../services/mcp-reads.service.js';

export default defineTool({
  name: 'get_campaign',
  title: 'Get one campaign',
  description: 'One campaign with the clients that buy it, the ad accounts that feed it, and how many assets it has. campaignId may be the Stato UUID or the LeadByte number. IDs are strings.',
  inputSchema: { campaignId: z.string().min(1).max(100).describe('Stato campaign UUID, or the LeadByte campaign number.') },
  outputSchema: {
    campaign: z.object({ campaignId: z.string(), leadbyteId: z.string().nullable(), name: z.string(), vertical: z.string().nullable(), status: z.string().nullable(), currency: z.string().nullable() }),
    linkedClients: z.array(z.object({ clientId: z.string(), name: z.string() })),
    adAccounts: z.array(z.object({ platform: z.string(), accountId: z.string(), accountName: z.string().nullable(), clientId: z.string().nullable() })),
    creativeCount: z.number(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'campaigns:read',
  handler: async ({ campaignId }, ctx) => {
    const d = await getCampaignForMcp(ctx.businessId, campaignId);
    return { summary: `${d.campaign.name}: ${d.linkedClients.length} clients, ${d.adAccounts.length} ad accounts, ${d.creativeCount} assets.`, data: d };
  },
});
