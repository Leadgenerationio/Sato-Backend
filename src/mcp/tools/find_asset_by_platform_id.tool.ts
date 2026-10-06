import { z } from 'zod';
import { defineTool } from '../types.js';
import { adLinkOut } from '../schemas.js';
import { findAssetByPlatformId } from '../../services/creative-ad-links.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'find_asset_by_platform_id',
  title: 'Find an asset by platform ID or file hash',
  description:
    'Check whether Stato already has an asset, before you upload or link, to avoid duplicates. Send platform plus one of adId, platformCreativeId or platformAssetId, or just a sha256. ' +
    'Nothing found is a normal answer (found = false), not an error. IDs are strings.',
  inputSchema: {
    platform: z.string().max(50).optional().describe('meta, google, tiktok or taboola. Needed with an ad or creative ID; not needed with sha256.'),
    adId: z.string().max(100).optional(),
    platformCreativeId: z.string().max(100).optional(),
    platformAssetId: z.string().max(255).optional(),
    sha256: z.string().length(64).optional().describe('SHA-256 of the file, 64 hex characters.'),
  },
  outputSchema: {
    found: z.boolean(),
    creative: z.object({
      id: z.string(), name: z.string(), type: z.string().nullable(), clientId: z.string().nullable(), campaignId: z.string().nullable(),
      approvalStatus: z.string(), fileStatus: z.string(), archivedAt: z.string().nullable(), sha256: z.string().nullable(),
    }).nullable(),
    adLink: adLinkOut.nullable(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'creatives:read',
  handler: async (args, ctx) => {
    const res = await findAssetByPlatformId({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args);
    return {
      summary: res.found ? `Found asset ${res.creative!.name} (${res.creative!.id}).` : 'No asset matches. It is safe to upload it.',
      data: res,
    };
  },
});
