import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { createUpload } from '../../services/mcp-uploads.service.js';
import { realUserId } from '../../services/ad-account-rules.service.js';

export default defineTool({
  name: 'create_upload',
  title: 'Start a direct file upload',
  description:
    'Start an upload for a file too big to send as a sourceUrl (images up to 30 MB, videos up to 4 GB). Declare the filename, contentType and exact sizeBytes; ' +
    'a file over the limit or of an unsupported type is refused now, before anything is sent. You get either one uploadUrl (PUT the whole file with the headers given) or a list of parts: PUT each part\'s bytes to its url and keep the ETag response header of every part. ' +
    'Then call complete_upload, and finally upload_asset with the uploadId. Links last 6 hours. Allowed types: image/jpeg, image/png, image/webp, image/gif, video/mp4, video/quicktime. Sizes are numbers of bytes.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(3).max(100).describe('image/jpeg, image/png, image/webp, image/gif, video/mp4 or video/quicktime.'),
    sizeBytes: z.number().int().positive().describe('The exact size of the file in bytes.'),
    sha256: z.string().length(64).optional().describe('Optional SHA-256 of the file; checked after upload.'),
  },
  outputSchema: {
    uploadId: z.string(),
    mode: z.enum(['single', 'multipart']),
    uploadUrl: z.string().nullable(),
    headers: z.record(z.string(), z.string()).nullable(),
    partSize: z.number().nullable(),
    parts: z.array(z.object({ partNumber: z.number(), url: z.string(), bytes: z.number() })).nullable(),
    expiresAt: z.string(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  scope: 'uploads:write',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'create_upload', args, async () => {
    const res = await createUpload({ businessId: ctx.businessId, userId: realUserId(ctx.userId), keyId: ctx.apiKey.id }, args as Parameters<typeof createUpload>[1]);
    const how = res.mode === 'single' ? 'PUT the file to uploadUrl' : `PUT each of the ${res.parts!.length} parts to its url and note every ETag`;
    return {
      summary: `Upload ${res.uploadId} started. ${how}, then call complete_upload.`,
      data: res,
      audit: { after: { uploadId: res.uploadId, mode: res.mode }, recordsTouched: [{ type: 'upload', id: res.uploadId }] },
    };
    });
  },
});
