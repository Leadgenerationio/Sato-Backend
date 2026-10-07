import { z } from 'zod';
import { defineTool } from '../types.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { adLinkOut } from '../schemas.js';
import { getAsset } from '../../services/mcp-assets.service.js';

export default defineTool({
  name: 'get_asset',
  title: 'Get one asset',
  description:
    'Full detail of one asset with a signed download link and its ad links. The link lasts 60 minutes by default; ask for up to 1440 (24 hours) with downloadUrlMinutes if a platform needs longer. ' +
    'Use the downloadUrl as the video_url or image URL in your ad-platform tool. approvalStatus is reported, not enforced. downloadUrl is null for copy-only assets or when the file is missing. For a video, fileStatus processing only means the poster and duration are not read yet; the file itself is already checked and the link works. IDs are strings.',
  inputSchema: {
    creativeId: uuidShape().describe('Stato asset ID (UUID), from list_assets.'),
    downloadUrlMinutes: z.number().int().min(1).max(1440).optional(),
  },
  outputSchema: {
    creative: z.object({
      creativeId: z.string(), name: z.string(), mediaType: z.string().nullable(), contentType: z.string().nullable(), sizeBytes: z.number().nullable(),
      width: z.number().nullable(), height: z.number().nullable(), durationSeconds: z.number().nullable(), sha256: z.string().nullable(),
      fileStatus: z.string(), approvalStatus: z.string(), section: z.string(), headline: z.string().nullable(), bodyText: z.string().nullable(),
      tags: z.array(z.string()), source: z.string(), clientId: z.string().nullable(), clientName: z.string().nullable(), campaignId: z.string().nullable(),
      campaignName: z.string().nullable(), archivedAt: z.string().nullable(), createdAt: z.string().nullable(), thumbnailUrl: z.string().nullable(),
    }),
    downloadUrl: z.string().nullable(),
    expiresAt: z.string().nullable(),
    adLinks: z.array(adLinkOut),
    landingPage: z.object({ id: z.string(), url: z.string(), title: z.string().nullable() }).nullable(),
    history: z.array(z.object({ at: z.string(), tool: z.string().nullable(), by: z.string().nullable(), transport: z.string(), result: z.string() })).describe('The latest API-key calls that touched this asset in the last 90 days, newest first (at most 10).'),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'creatives:read',
  handler: async ({ creativeId, downloadUrlMinutes }, ctx) => {
    const d = await getAsset(ctx.businessId, creativeId, downloadUrlMinutes);
    return { summary: `${d.creative.name}: ${d.adLinks.filter((l) => l.status !== 'removed').length} ad links${d.downloadUrl ? `, download link valid until ${d.expiresAt}` : ', no download link'}.`, data: d };
  },
});
