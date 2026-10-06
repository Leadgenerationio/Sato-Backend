import { z } from 'zod';
import { defineTool } from '../types.js';
import { adLinkOut } from '../schemas.js';
import { ApiError } from '../../utils/api-error.js';
import { uploadAssetFromUrl } from '../../services/mcp-upload.service.js';
import { withIdempotency } from '../../services/tool-idempotency.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'upload_asset',
  title: 'Add an image or video to Stato',
  description:
    'File an image or video under the right client and campaign. Send either a public sourceUrl (up to 50 MB) or an uploadId: for bigger files (up to 4 GB) call create_upload, send the file to the returned URLs, call complete_upload until status is ready, then call this with the uploadId. ' +
    'Call find_client_by_ad_account first. Send platform and platformAccountId and Stato picks the client from the ad account; clientId is only a cross-check and a mismatch is rejected (account_client_mismatch) with nothing saved. ' +
    'An unlinked account is account_not_linked: stop and ask the owner. If the account feeds several campaigns you must send campaignId. ' +
    'Optionally send adLink to record the ad in the same call (the IDs the platform returned; all strings). ' +
    'Safe to repeat: the same file for the same client returns result "duplicate" with the existing creativeId; the same idempotencyKey replays the first answer for 24 hours.',
  inputSchema: {
    mediaType: z.enum(['image', 'video']).optional().describe('Required with sourceUrl. With uploadId it is read from the file.'),
    sourceUrl: z.string().min(1).max(2000).optional().describe('Public http(s) URL of a file up to 50 MB. Private and internal addresses are blocked. Send this or uploadId.'),
    uploadId: z.string().min(1).optional().describe('From create_upload, after complete_upload reports ready. Send this or sourceUrl.'),
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
      platformCampaignId: z.string().max(100).optional().describe('The ad platform\'s own campaign ID. The Stato campaign is the top-level campaignId.'),
      platformCampaignName: z.string().max(255).optional(),
      adsetId: z.string().max(100).optional(), adsetName: z.string().max(255).optional(),
      adId: z.string().max(100).optional(), adName: z.string().max(255).optional(),
      platformCreativeId: z.string().max(100).optional(), platformAssetId: z.string().max(255).optional(),
      status: z.enum(['active', 'paused', 'unknown']).optional(),
    }).optional().describe('Needs the ad_links:write scope as well.'),
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
    adLinkResult: z.enum(['created', 'updated', 'unchanged', 'duplicate']).nullable().describe('duplicate: the ad already runs another asset. This asset is saved; nothing was linked.'),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  scope: 'creatives:write',
  handler: async (args, ctx) => {
    if (args.adLink && !ctx.apiKey.scopes.includes('ad_links:write')) {
      throw new ApiError('insufficient_scope', 'This API key does not have the "ad_links:write" scope, which adLink needs.', {
        hint: 'Ask the owner to add that scope in Settings, API keys, or send the file without adLink. Nothing was saved.',
      });
    }
    const { idempotencyKey, ...request } = args;
    const caller = { businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id };
    const { value, replayed } = await withIdempotency(ctx.apiKey.id, idempotencyKey, 'upload_asset', request, async () => {
      const { audit: _audit, ...res } = await uploadAssetFromUrl(caller, request as Parameters<typeof uploadAssetFromUrl>[1]);
      return res as unknown as Record<string, unknown>;
    });
    const out = value as unknown as { creativeId: string; result: 'created' | 'updated' | 'duplicate'; name: string; mediaType: string | null; sizeBytes: number | null; fileStatus: string; approvalStatus: string; adLink: z.infer<typeof adLinkOut> | null; adLinkResult: 'created' | 'updated' | 'unchanged' | 'duplicate' | null };
    const summary = replayed ? `Same request as before (idempotencyKey): returning the first answer, asset ${out.creativeId}.`
      : out.result === 'created' ? `Added "${out.name}" as asset ${out.creativeId}.`
      : out.result === 'duplicate' ? `That file is already in Stato for this client: asset ${out.creativeId}. Nothing new was added.`
      : `Updated asset ${out.creativeId}.`;
    const note = out.adLinkResult === 'duplicate' ? ` That ad already runs another asset (${out.adLink?.creativeId}), so the ad was not linked; unlink it first if it changed asset.` : '';
    return {
      summary: summary + note,
      data: { ...out, replayed },
      audit: { after: { creativeId: out.creativeId, result: out.result, replayed }, recordsTouched: [{ type: 'creative', id: out.creativeId }] },
    };
  },
});
