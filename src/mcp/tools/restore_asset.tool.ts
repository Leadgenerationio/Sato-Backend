import { z } from 'zod';
import { defineTool } from '../types.js';
import { restoreAsset } from '../../services/creative-asset-actions.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'restore_asset',
  title: 'Restore an archived asset',
  description:
    'Bring an archived asset back into the default lists, exactly as it was. Safe to repeat: an asset that is not archived returns unchanged. IDs are strings.',
  inputSchema: {
    creativeId: z.string().min(1).describe('Stato asset ID (UUID).'),

  },
  outputSchema: {
    result: z.enum(['restored', 'unchanged']),
    creative: z.object({ creativeId: z.string(), name: z.string(), archivedAt: z.string().nullable(), archiveReason: z.string().nullable() }),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'creatives:archive',
  handler: async (args, ctx) => {
    const res = await restoreAsset({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args.creativeId);
    return {
      summary: res.result === 'unchanged' ? 'Nothing changed.' : `Asset ${res.creative.creativeId} is now restored.`,
      data: { result: res.result, creative: { creativeId: res.creative.creativeId, name: res.creative.name, archivedAt: res.creative.archivedAt, archiveReason: res.creative.archiveReason } },
      audit: { before: res.before, after: res.creative, recordsTouched: [{ type: 'creative', id: res.creative.creativeId }] },
    };
  },
});
