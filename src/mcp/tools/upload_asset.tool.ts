import { z } from 'zod';
import { defineTool } from '../types.js';
import { adLinkOut } from '../schemas.js';
import { uploadAssetFromUrl } from '../../services/mcp-upload.service.js';
import { withIdempotency } from '../../services/tool-idempotency.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'upload_asset',
  title: 'Add an image or video to Stato',
  description:
    'File an image or video under the right client and campaign, from a public sourceUrl (up to 50 MB; larger files need create_upload). ' +
    'Call find_client_by_ad_account first. Send platform and platformAccountId and Stato picks the client from the ad account; clientId is only a cross-check and a mismatch is rejected (account_client_mismatch) with nothing saved. ' +
    'An unlinked account is account_not_linked: stop and ask the owner. If the account feeds several campaigns you must send campaignId. ' +
    'Optionally send adLink to record the ad in the same call (the IDs the platform returned; all strings). ' +
    'Safe to repeat: the same file for the same client returns result "duplicate" with the existing creativeId; the same idempotencyKey replays the first answer for 24 hours.',
  inputSchema: {
    mediaType: z.enum(['image', 'video']),
    sourceUrl: z.string().min(1).max(2000).describe('Public http(s) URL of the file. Private and internal addresses are blocked.'),
    name: z.string().max(255).optional(),
    platform: z.string().max(50).optional().describe('meta, google, tiktok or taboola. With platformAccountId, the ad account decides the client.'),
    platformAccountId: z.string().max(100).optional().describe('The ad account ID as a string (Meta with or without act_).'),
    clientId: z.string().optional().describe('Stato client ID. Only needed when there is no ad account; otherwise a cross-check.'),
    campaignId: z.string().max(100).optional().describe('Stato campaign UUID or the LeadByte number. Required when the account feeds more than one campaign.'),
    headline: z.string().max(2000).optional(),
    bodyText: z.string().max(10000).optional(),
    landingPageUrl: z.string().max(2000).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    adLink: z.object({
      campaignId: z.string().max(100).optional().describe('The PLATFORM campaign ID.'),
      campaignName: z.string().max(255).optional(),
      adsetId: z.string().max(100).optional(), adsetName: z.string().max(255).optional(),
      adId: z.string().max(100).optional(), adName: z.string().max(255).optional(),
      platformCreativeId: z.string().max(100).optional(), platformAssetId: z.string().max(255).optional(),
      status: z.enum(['active', 'paused', 'removed', 'unknown']).optional(),
    }).optional(),
    idempotencyKey: z.string().max(100).optional(),
  },
  outputSchema: {
    creativeId: z.string(),
    result: z.enum(['created', 'updated', 'duplicate']),
    replayed: z.boolean(),
    name: z.string(),
    mediaType: z.string().nullable(),
    sizeBytes: z.number().nullable(),
    fileStatus: z.string(),
    approvalStatus: z.string(),
    adLink: adLinkOut.nullable(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  scope: 'creatives:write',
  handler: async (args, ctx) => {
    const { idempotencyKey, ...request } = args;
    const caller = { businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id };
    const { value, replayed } = await withIdempotency(ctx.apiKey.id, idempotencyKey, 'upload_asset', request, async () => {
      const { audit: _audit, ...res } = await uploadAssetFromUrl(caller, request as Parameters<typeof uploadAssetFromUrl>[1]);
      return res as unknown as Record<string, unknown>;
    });
    const out = value as unknown as { creativeId: string; result: 'created' | 'updated' | 'duplicate'; name: string; mediaType: string | null; sizeBytes: number | null; fileStatus: string; approvalStatus: string; adLink: z.infer<typeof adLinkOut> | null };
    const summary = replayed ? `Same request as before (idempotencyKey): returning the first answer, asset ${out.creativeId}.`
      : out.result === 'created' ? `Added "${out.name}" as asset ${out.creativeId}.`
      : out.result === 'duplicate' ? `That file is already in Stato for this client: asset ${out.creativeId}. Nothing new was added.`
      : `Updated asset ${out.creativeId}.`;
    return {
      summary,
      data: { ...out, replayed },
      audit: { after: { creativeId: out.creativeId, result: out.result, replayed }, recordsTouched: [{ type: 'creative', id: out.creativeId }] },
    };
  },
});
