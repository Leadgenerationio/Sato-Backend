import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { unlinkAdPlatformIds } from '../../services/creative-ad-links.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';

export default defineTool({
  name: 'unlink_ad_platform_ids',
  title: 'Remove a wrong ad link',
  description:
    'Remove an ad link that was recorded by mistake. The link is marked removed and kept in history; the asset and its file are untouched. ' +
    'Find the adLinkId with find_asset_by_platform_id or get_asset. Safe to repeat: an already removed link returns unchanged.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    adLinkId: uuidShape().describe('The ad link ID (UUID).'),
    reason: z.string().max(500).optional().describe('Why it is being removed. Stored in the audit log.'),
  },
  outputSchema: { result: z.enum(['removed', 'unchanged']), adLinkId: z.string(), removedAt: z.string().nullable() },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  scope: 'ad_links:write',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    const { adLinkId } = args;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'unlink_ad_platform_ids', args, async () => {

    const res = await unlinkAdPlatformIds({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, adLinkId);
    return {
      summary: res.result === 'removed' ? 'The ad link was removed and kept in history.' : 'That ad link was already removed.',
      data: { result: res.result, adLinkId: res.link.adLinkId, removedAt: res.link.removedAt },
      audit: { before: res.before, after: res.link, recordsTouched: [{ type: 'ad_link', id: res.link.adLinkId }] },
    };
    });
  },
});
