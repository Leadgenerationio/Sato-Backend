import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { uploads } from '../db/schema/uploads.js';
import { abortMultipart, completeMultipart, createMultipart, uploadPart, type CompletedPart } from '../integrations/r2/r2-multipart.js';
import { isR2Configured } from '../integrations/r2/r2-client.js';
import { isGenericBinary, openPublicUrl, type RemoteMediaDeps } from '../utils/remote-media.js';
import { MediaSourceError } from '../utils/errors.js';
import { IMAGE_MAX_BYTES, SNIFF_BYTES, sniffMedia } from '../utils/sniff-media.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import type { Caller } from './ad-account-rules.service.js';

// MCP spec v1.0, files from 50 MB up to 1 GB by URL. The API only starts the copy; a background worker streams the
// file from the public URL straight into storage as a multipart upload, one 64 MiB part in memory at a time, hashing as
// it goes. The caller polls complete_upload with the uploadId until it is ready, then files it with upload_asset.

const MiB = 1024 * 1024;
export const URL_UPLOAD_MAX_BYTES = 1024 * MiB;
const PART_BYTES = 64 * MiB;
const COPY_TIMEOUT_MS = 30 * 60 * 1000;
/** A copy for the same URL started within this time is reused instead of started again. */
const REUSE_WINDOW_MS = 60 * 60 * 1000;
/** Copies running at once per business. Each can pull 1 GB, and the media worker also makes posters and hashes uploads. */
export const MAX_URL_COPIES = 5;

const urlTag = (sourceUrl: string) => createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
const safeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';

/** Check the URL (public address, redirects, type, size) and start the background copy. Returns the uploadId to poll. */
export async function startUrlUpload(caller: Caller, sourceUrl: string, deps: RemoteMediaDeps = {}): Promise<{ uploadId: string; reused: boolean }> {
  if (!isR2Configured()) throw new ApiError('internal_error', 'File storage is not configured.');
  const tag = `url-${urlTag(sourceUrl)}-`;
  const [recent] = await db.select().from(uploads).where(and(
    eq(uploads.businessId, caller.businessId), eq(uploads.mode, 'url'), gt(uploads.createdAt, new Date(Date.now() - REUSE_WINDOW_MS)),
  )).orderBy(desc(uploads.createdAt)).limit(20).then((rows) => rows.filter((r) => r.filename.startsWith(tag) && r.status !== 'failed' && r.status !== 'expired'));
  if (recent) return { uploadId: recent.id, reused: true };

  // A different query string is a different URL, so the reuse check above does not cover it: cap the copies themselves.
  const [running] = await db.select({ n: count() }).from(uploads).where(and(eq(uploads.businessId, caller.businessId), eq(uploads.mode, 'url'), eq(uploads.status, 'processing')));
  if ((running?.n ?? 0) >= MAX_URL_COPIES) {
    throw new ApiError('rate_limited', `${MAX_URL_COPIES} files are already being copied from URLs for this business.`, {
      retryable: true, details: { retryAfter: 30 }, hint: 'Wait for them to finish (poll complete_upload with their uploadIds), then send this one again.',
    });
  }

  const { res, finalUrl } = await openPublicUrl(sourceUrl, deps);
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new MediaSourceError(422, `Could not download sourceUrl (HTTP ${res.status})`, 'source_unreachable');
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type && !type.startsWith('image/') && !type.startsWith('video/') && !isGenericBinary(type)) {
    throw new MediaSourceError(422, `sourceUrl must be an image or video, got "${type}"`, 'unsupported_type');
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > URL_UPLOAD_MAX_BYTES) {
    throw new ApiError('file_too_large', `The file at sourceUrl is ${declared} bytes; a URL upload takes up to ${URL_UPLOAD_MAX_BYTES} bytes (1 GB).`, {
      hint: 'For anything over 1 GB use create_upload and send the file in parts (up to 4 GB).',
    });
  }
  if (type.startsWith('image/') && declared > IMAGE_MAX_BYTES) {
    throw new ApiError('file_too_large', `The image at sourceUrl is ${declared} bytes; images are up to ${IMAGE_MAX_BYTES} bytes (${IMAGE_MAX_BYTES / (1024 * 1024)} MB).`, {
      hint: 'Make the image smaller. The 1 GB URL copy is for videos.',
    });
  }
  const name = decodeURIComponent(finalUrl.pathname.split('/').filter(Boolean).pop() ?? 'file');
  const key = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(name)}`;
  const [row] = await db.insert(uploads).values({
    businessId: caller.businessId, createdBy: caller.userId, createdByKeyId: caller.keyId, filename: `${tag}${name}`.slice(0, 255),
    contentType: type || null, sizeBytes: declared || null, r2Key: key, mode: 'url', status: 'processing',
  }).returning();
  const uploadId = row!.id;
  const { mediaQueue } = await import('../jobs/queue.js');
  if (mediaQueue) {
    await mediaQueue.add('fetch-url-upload', { uploadId, sourceUrl }, { attempts: 1, removeOnComplete: 200, removeOnFail: 200 });
  } else {
    void runUrlUpload(uploadId, sourceUrl, deps); // no queue (tests, local): run in this process
  }
  return { uploadId, reused: false };
}

/** The worker job: stream the URL into storage, check the real type from the first bytes, hash, and mark it ready. */
export async function runUrlUpload(uploadId: string, sourceUrl: string, deps: RemoteMediaDeps = {}): Promise<'ready' | 'failed' | 'skipped'> {
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (!row || row.mode !== 'url' || row.status !== 'processing') return 'skipped';
  // Time spent waiting in the queue must not count toward the stuck-processing sweep: the clock starts now.
  await db.update(uploads).set({ updatedAt: new Date() }).where(eq(uploads.id, uploadId));
  let multipartId: string | null = null;
  const fail = async (message: string): Promise<'failed'> => {
    if (multipartId) await abortMultipart('creatives', row.r2Key, multipartId).catch((err: unknown) => logger.warn({ err, uploadId }, 'Could not abort a failed URL upload'));
    await db.update(uploads).set({ status: 'failed', error: message.slice(0, 1000), multipartUploadId: null, updatedAt: new Date() }).where(eq(uploads.id, uploadId));
    return 'failed';
  };
  try {
    const { res } = await openPublicUrl(sourceUrl, deps, { timeoutMs: COPY_TIMEOUT_MS });
    if (!res.ok || !res.body) return await fail(`Could not download sourceUrl (HTTP ${res.status})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > URL_UPLOAD_MAX_BYTES) { await res.body.cancel().catch(() => {}); return await fail('The file is larger than 1 GB'); }

    multipartId = await createMultipart('creatives', row.r2Key, row.contentType ?? 'application/octet-stream');
    await db.update(uploads).set({ multipartUploadId: multipartId, updatedAt: new Date() }).where(eq(uploads.id, uploadId));
    const hash = createHash('sha256');
    const parts: CompletedPart[] = [];
    // One reusable 64 MiB buffer (about 64 MiB per copy, no second copy when a part is sent).
    const partBuf = Buffer.allocUnsafe(PART_BYTES);
    const head = Buffer.alloc(SNIFF_BYTES); let headLen = 0; // the first bytes, kept for the file-type check
    let bufferedBytes = 0; let total = 0; let sniffed: ReturnType<typeof sniffMedia> | undefined;
    const flush = async () => {
      if (bufferedBytes === 0) return;
      const n = bufferedBytes;
      bufferedBytes = 0;
      parts.push({ partNumber: parts.length + 1, etag: await uploadPart('creatives', row.r2Key, multipartId!, parts.length + 1, partBuf.subarray(0, n)) });
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > URL_UPLOAD_MAX_BYTES) return await fail('The file is larger than 1 GB');
      // Images are up to 30 MB whatever the headers said (only videos may be up to 1 GB by URL): the real type is known after the first bytes.
      if (sniffed?.mediaType === 'image' && total > IMAGE_MAX_BYTES) return await fail(`Images are up to ${IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
      hash.update(buf);
      if (headLen < SNIFF_BYTES) headLen += buf.copy(head, headLen, 0, Math.min(buf.length, SNIFF_BYTES - headLen));
      let offset = 0;
      while (offset < buf.length) {
        const take = Math.min(buf.length - offset, PART_BYTES - bufferedBytes);
        buf.copy(partBuf, bufferedBytes, offset, offset + take);
        bufferedBytes += take; offset += take;
        if (bufferedBytes >= PART_BYTES) await flush();
      }
      if (sniffed === undefined && headLen >= SNIFF_BYTES) {
        sniffed = sniffMedia(head);
        if (!sniffed) return await fail('The file content is not a jpg, png, webp, gif, mp4 or mov, whatever its name says');
        if (sniffed.mediaType === 'image' && total > IMAGE_MAX_BYTES) return await fail(`Images are up to ${IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
      }
    }
    if (sniffed?.mediaType === 'image' && total > IMAGE_MAX_BYTES) return await fail(`Images are up to ${IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
    if (sniffed === undefined) {
      sniffed = sniffMedia(head.subarray(0, headLen));
      if (!sniffed) return await fail('The file content is not a jpg, png, webp, gif, mp4 or mov, whatever its name says');
    }
    if (total === 0) return await fail('The file at sourceUrl is empty');
    await flush();
    await completeMultipart('creatives', row.r2Key, multipartId, parts);
    await db.update(uploads).set({
      status: 'ready', sizeBytes: total, sha256: hash.digest('hex'), contentType: sniffed!.mime, multipartUploadId: null, error: null, updatedAt: new Date(),
    }).where(and(eq(uploads.id, uploadId), eq(uploads.status, 'processing')));
    return 'ready';
  } catch (err) {
    logger.warn({ err, uploadId }, 'URL upload failed');
    const reason = err instanceof MediaSourceError ? err.message : err instanceof Error && err.name === 'TimeoutError' ? 'Copying the file took longer than 30 minutes' : 'The file could not be copied from sourceUrl';
    return await fail(reason);
  }
}
