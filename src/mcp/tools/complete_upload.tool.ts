import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { completeUpload } from '../../services/mcp-uploads.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'complete_upload',
  title: 'Finish a direct file upload',
  description:
    'Tell Stato the file is uploaded. For a multipart upload send parts: the partNumber and ETag of every part. Stato checks the real size and the real file type from the first bytes (an .exe renamed .mp4 is refused and removed) and computes the SHA-256. ' +
    'status "ready" means you can call upload_asset with the uploadId. status "processing" (very large files) means call complete_upload again with the same uploadId until it is ready. Safe to repeat. The same call also reports a file Stato is copying from a big sourceUrl (upload_asset answers upload_incomplete with that uploadId). IDs are strings.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    uploadId: uuidShape(),
    parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) })).max(10000).optional().describe('Every uploaded part with its ETag. Needed for a multipart upload.'),
  },
  outputSchema: {
    uploadId: z.string(),
    status: z.enum(['ready', 'processing', 'error']).describe('ready, or processing (call again). error when the call failed: see code and hint.'),
    sizeBytes: z.number(),
    contentType: z.string(),
    sha256: z.string().nullable(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  scope: 'uploads:write',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    const { uploadId, parts } = args;
    // A poll that is not final (status processing) is not kept, so the same key can be used until the file is ready.
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'complete_upload', args, async () => {

    const res = await completeUpload({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, uploadId, parts);
    return {
      summary: res.status === 'ready' ? `Upload ${res.uploadId} is ready (${res.contentType}, ${res.sizeBytes} bytes). Call upload_asset with this uploadId.` : `Upload ${res.uploadId} is still being checked. Call complete_upload again shortly.`,
      data: res,
      audit: { after: { uploadId: res.uploadId, status: res.status }, recordsTouched: [{ type: 'upload', id: res.uploadId }] },
    };
    }, (r) => r.data.status === 'ready');
  },
});
