import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { archiveAsset } from '../../services/creative-asset-actions.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'archive_asset',
  title: 'Archive an asset',
  description:
    'Hide an asset from the default lists. The file is never deleted and nothing else changes; any ad that already runs it keeps running. Give a reason if you can. Safe to repeat: an already archived asset returns unchanged. Undo with restore_asset. IDs are strings.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    creativeId: uuidShape().describe('Stato asset ID (UUID).'),
    reason: z.string().max(255).optional().describe('Why it is being archived. Kept with the asset and in the audit log.'),
  },
  outputSchema: {
    result: z.enum(['archived', 'unchanged']),
    creative: z.object({ creativeId: z.string(), name: z.string(), archivedAt: z.string().nullable(), archiveReason: z.string().nullable() }),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  scope: 'creatives:archive',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'archive_asset', args, async () => {
    const res = await archiveAsset({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args.creativeId, args.reason);
    return {
      summary: res.result === 'unchanged' ? 'Nothing changed.' : `Asset ${res.creative.creativeId} is now archived.`,
      data: { result: res.result, creative: { creativeId: res.creative.creativeId, name: res.creative.name, archivedAt: res.creative.archivedAt, archiveReason: res.creative.archiveReason } },
      audit: { before: res.before, after: res.creative, recordsTouched: [{ type: 'creative', id: res.creative.creativeId }] },
    };
    });
  },
});
