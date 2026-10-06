import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { updateAsset } from '../../services/creative-asset-actions.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

const assetOut = z.object({
  creativeId: z.string(), name: z.string(), headline: z.string().nullable(), bodyText: z.string().nullable(), tags: z.array(z.string()),
  clientId: z.string().nullable(), campaignId: z.string().nullable(), archivedAt: z.string().nullable(), archiveReason: z.string().nullable(),
});

export default defineTool({
  name: 'update_asset',
  title: 'Change an asset',
  description:
    'Change an asset\'s name, headline, bodyText, tags (replaces the list) or campaign. Moving it to another client (clientId) needs confirmMove = true; ask the owner first. ' +
    'A move is refused if the asset has a live ad on an ad account that belongs to its current client (unlink it first). The new campaignId must belong to the client. Sends back changedFields; sending the same values changes nothing. IDs are strings.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    creativeId: uuidShape(),
    name: z.string().min(1).max(255).optional(),
    headline: z.string().max(2000).optional(),
    bodyText: z.string().max(10000).optional(),
    tags: z.array(z.string().max(50)).max(20).optional().describe('The full list of tags; replaces the current ones.'),
    campaignId: z.string().max(100).optional().describe('Stato campaign UUID or the LeadByte number.'),
    clientId: uuidShape().optional().describe('Move to this client. Needs confirmMove.'),
    confirmMove: z.boolean().optional(),
  },
  outputSchema: { creative: assetOut, changedFields: z.array(z.string()) },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'creatives:write',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'update_asset', args, async () => {
    const res = await updateAsset({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args as Parameters<typeof updateAsset>[1]);
    return {
      summary: res.changedFields.length ? `Changed ${res.changedFields.join(', ')} on asset ${res.creative.creativeId}.` : 'Nothing to change: the values already match.',
      data: { creative: res.creative, changedFields: res.changedFields },
      audit: { before: res.before, after: res.creative, recordsTouched: [{ type: 'creative', id: res.creative.creativeId }] },
    };
    });
  },
});
