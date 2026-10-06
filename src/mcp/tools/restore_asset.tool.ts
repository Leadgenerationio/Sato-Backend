import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { restoreAsset } from '../../services/creative-asset-actions.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'restore_asset',
  title: 'Restore an archived asset',
  description:
    'Bring an archived asset back into the default lists, exactly as it was. Safe to repeat: an asset that is not archived returns unchanged. IDs are strings.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    creativeId: uuidShape().describe('Stato asset ID (UUID).'),

  },
  outputSchema: {
    result: z.enum(['restored', 'unchanged']),
    creative: z.object({ creativeId: z.string(), name: z.string(), archivedAt: z.string().nullable(), archiveReason: z.string().nullable() }),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'creatives:archive',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'restore_asset', args, async () => {
    const res = await restoreAsset({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args.creativeId);
    return {
      summary: res.result === 'unchanged' ? 'Nothing changed.' : `Asset ${res.creative.creativeId} is now restored.`,
      data: { result: res.result, creative: { creativeId: res.creative.creativeId, name: res.creative.name, archivedAt: res.creative.archivedAt, archiveReason: res.creative.archiveReason } },
      audit: { before: res.before, after: res.creative, recordsTouched: [{ type: 'creative', id: res.creative.creativeId }] },
    };
    });
  },
});
