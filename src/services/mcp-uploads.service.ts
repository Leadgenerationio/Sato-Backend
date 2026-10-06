import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { uploads, type UploadRow } from '../db/schema/uploads.js';
import { getSignedUploadUrl, hashObject, isR2Configured, deleteFile, ObjectTooLargeError } from '../integrations/r2/r2-client.js';
import { abortMultipart, completeMultipart, createMultipart, headObjectInfo, presignUploadPart, readObjectHead, type CompletedPart } from '../integrations/r2/r2-multipart.js';
import { ALLOWED_MIME, IMAGE_MAX_BYTES, SNIFF_BYTES, VIDEO_MAX_BYTES, sniffMedia } from '../utils/sniff-media.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import type { Caller } from './ad-account-rules.service.js';

// MCP spec v1.0 create_upload / complete_upload: direct uploads from the caller
// to storage. Rules are checked before any byte moves (declared size and type),
// and again on the stored object (real size, real file type from the first bytes,
// real SHA-256). Anything refused is removed from storage.

const MiB = 1024 * 1024;
const SINGLE_MAX_BYTES = 64 * MiB;
const PART_BYTES = 64 * MiB;
const MAX_PARTS = 9000;
const URL_TTL_SECONDS = 6 * 60 * 60;
/** Hash inside complete_upload up to this size; larger files hash in the background. */
const INLINE_HASH_MAX_BYTES = 1024 * MiB;
const PROCESSING_TIMEOUT_MS = 45 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/i;

const safeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';

export interface CreateUploadInput { filename: string; contentType: string; sizeBytes: number; sha256?: string }
export interface CreateUploadResult {
  uploadId: string;
  mode: 'single' | 'multipart';
  uploadUrl: string | null;
  headers: Record<string, string> | null;
  partSize: number | null;
  parts: Array<{ partNumber: number; url: string; bytes: number }> | null;
  expiresAt: string;
}

export function uploadLimit(contentType: string): number {
  return contentType.startsWith('video/') ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

export async function createUpload(caller: Caller, input: CreateUploadInput): Promise<CreateUploadResult> {
  if (!(ALLOWED_MIME as readonly string[]).includes(input.contentType)) {
    throw new ApiError('unsupported_type', `${input.contentType} is not supported.`, { hint: 'Use jpg, png, webp or gif images, or mp4 or mov videos.' });
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new ApiError('validation_failed', 'sizeBytes must be a whole number of bytes above zero.', { fields: [{ field: 'sizeBytes', message: 'Required, in bytes' }] });
  }
  const limit = uploadLimit(input.contentType);
  if (input.sizeBytes > limit) {
    // Refused before a byte is stored: nothing is created in storage or the database.
    throw new ApiError('file_too_large', `This ${input.contentType.split('/')[0]} is ${input.sizeBytes} bytes; the limit is ${limit} bytes (${limit / MiB / 1024 >= 1 ? `${limit / MiB / 1024} GB` : `${limit / MiB} MB`}).`, {
      hint: input.contentType.startsWith('video/') ? 'Videos can be up to 4 GB. Compress or trim the file.' : 'Images can be up to 30 MB.',
    });
  }
  if (input.sha256 && !SHA256.test(input.sha256)) {
    throw new ApiError('validation_failed', 'sha256 must be 64 hex characters.', { fields: [{ field: 'sha256', message: '64 hex characters' }] });
  }
  if (!isR2Configured()) throw new ApiError('internal_error', 'File storage is not configured.', { retryable: false });

  const key = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(input.filename)}`;
  const mode: 'single' | 'multipart' = input.sizeBytes <= SINGLE_MAX_BYTES ? 'single' : 'multipart';
  const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000);
  let multipartId: string | null = null;
  let result: Pick<CreateUploadResult, 'uploadUrl' | 'headers' | 'partSize' | 'parts'>;

  if (mode === 'single') {
    result = { uploadUrl: await getSignedUploadUrl({ folder: 'creatives', key, contentType: input.contentType, expiresInSeconds: URL_TTL_SECONDS }), headers: { 'Content-Type': input.contentType }, partSize: null, parts: null };
  } else {
    const partCount = Math.ceil(input.sizeBytes / PART_BYTES);
    if (partCount > MAX_PARTS) throw new ApiError('file_too_large', 'That file needs more parts than storage allows.');
    multipartId = await createMultipart('creatives', key, input.contentType);
    const parts: NonNullable<CreateUploadResult['parts']> = [];
    for (let n = 1; n <= partCount; n++) {
      parts.push({ partNumber: n, url: await presignUploadPart('creatives', key, multipartId, n, URL_TTL_SECONDS), bytes: n < partCount ? PART_BYTES : input.sizeBytes - PART_BYTES * (partCount - 1) });
    }
    result = { uploadUrl: null, headers: null, partSize: PART_BYTES, parts };
  }

  const [row] = await db.insert(uploads).values({
    businessId: caller.businessId, createdBy: caller.userId, createdByKeyId: caller.keyId, filename: input.filename.slice(0, 255), contentType: input.contentType,
    sizeBytes: input.sizeBytes, sha256: input.sha256?.toLowerCase() ?? null, r2Key: key, mode, multipartUploadId: multipartId, partSize: mode === 'multipart' ? PART_BYTES : null,
    status: 'uploading', expiresAt,
  }).returning();
  return { uploadId: row!.id, mode, ...result, expiresAt: expiresAt.toISOString() };
}

async function loadUpload(caller: Caller, uploadId: string): Promise<UploadRow> {
  const [row] = /^[0-9a-f-]{36}$/i.test(uploadId)
    ? await db.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.businessId, caller.businessId)))
    : [];
  if (!row) throw new ApiError('not_found', 'That upload does not exist.', { hint: 'Use the uploadId returned by create_upload.' });
  return row;
}

async function discardObject(row: UploadRow): Promise<void> {
  try {
    if (row.mode === 'multipart' && row.multipartUploadId) await abortMultipart('creatives', row.r2Key, row.multipartUploadId);
    await deleteFile('creatives', row.r2Key);
  } catch (err) {
    logger.warn({ err, uploadId: row.id }, 'Could not remove a refused upload from storage');
  }
}

async function failUpload(row: UploadRow, message: string): Promise<void> {
  await discardObject(row);
  await db.update(uploads).set({ status: 'failed', error: message.slice(0, 1000), updatedAt: new Date() }).where(eq(uploads.id, row.id));
}

export interface UploadStatus { uploadId: string; status: 'ready' | 'processing'; sizeBytes: number; contentType: string; sha256: string | null }
const statusOf = (r: UploadRow): UploadStatus => ({ uploadId: r.id, status: r.status === 'ready' ? 'ready' : 'processing', sizeBytes: Number(r.sizeBytes ?? 0), contentType: r.contentType ?? '', sha256: r.sha256 ?? null });

export async function completeUpload(caller: Caller, uploadId: string, parts?: CompletedPart[]): Promise<UploadStatus> {
  const row = await loadUpload(caller, uploadId);
  if (row.status === 'ready' || row.status === 'processing') return statusOf(row); // idempotent: asking again just reports
  if (row.status !== 'uploading') {
    throw new ApiError('upload_incomplete', `This upload is ${row.status}${row.error ? `: ${row.error}` : ''}.`, { hint: 'Start again with create_upload.' });
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await discardObject(row);
    await db.update(uploads).set({ status: 'expired', updatedAt: new Date() }).where(eq(uploads.id, row.id));
    throw new ApiError('upload_incomplete', 'The upload links expired before the file was finished.', { hint: 'Start again with create_upload.' });
  }
  if (row.mode === 'multipart' && (!parts || parts.length === 0)) {
    throw new ApiError('validation_failed', 'parts is required for a multipart upload: the partNumber and ETag of every part.', { fields: [{ field: 'parts', message: 'List every uploaded part with its etag' }] });
  }

  // Claim it, so two calls at once cannot both finish it.
  const [claimed] = await db.update(uploads).set({ status: 'processing', updatedAt: new Date() }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'uploading'))).returning();
  if (!claimed) return statusOf((await loadUpload(caller, uploadId)));

  if (row.mode === 'multipart') {
    try {
      await completeMultipart('creatives', row.r2Key, row.multipartUploadId!, parts!);
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'NoSuchUpload') {
        await db.update(uploads).set({ status: 'failed', error: 'The multipart upload no longer exists', updatedAt: new Date() }).where(eq(uploads.id, row.id));
        throw new ApiError('upload_incomplete', 'Storage no longer has this upload.', { hint: 'Start again with create_upload.' });
      }
      // Missing or too-small parts: let the caller fix it and try again.
      await db.update(uploads).set({ status: 'uploading', updatedAt: new Date() }).where(eq(uploads.id, row.id));
      throw new ApiError('upload_incomplete', 'Some parts are missing, wrong or too small.', {
        hint: 'Upload every part from parts[] (each except the last must be the full part size), then send every partNumber with the ETag the storage returned.',
        details: { storageError: name },
      });
    }
  }

  const head = await headObjectInfo('creatives', row.r2Key);
  if (!head) {
    await db.update(uploads).set({ status: 'uploading', updatedAt: new Date() }).where(eq(uploads.id, row.id));
    throw new ApiError('upload_incomplete', 'The file has not been uploaded yet.', { hint: 'PUT the file to uploadUrl first, then call complete_upload.' });
  }
  if (head.sizeBytes !== Number(row.sizeBytes)) {
    await failUpload(row, `Uploaded ${head.sizeBytes} bytes, declared ${row.sizeBytes}`);
    throw new ApiError('validation_failed', `The uploaded file is ${head.sizeBytes} bytes but sizeBytes was ${row.sizeBytes}. It was removed.`, {
      fields: [{ field: 'sizeBytes', message: 'Does not match the uploaded file' }], hint: 'Start again with create_upload and the real size.',
    });
  }
  const sniffed = sniffMedia((await readObjectHead('creatives', row.r2Key, SNIFF_BYTES)) ?? new Uint8Array(0));
  if (!sniffed || sniffed.mediaType !== (row.contentType ?? '').split('/')[0]) {
    await failUpload(row, 'The file content is not a supported image or video');
    throw new ApiError('unsupported_type', 'The file content is not a jpg, png, webp, gif, mp4 or mov, whatever its name says. It was removed.', {
      hint: 'Check the file and start again with create_upload.',
    });
  }
  await db.update(uploads).set({ contentType: sniffed.mime, updatedAt: new Date() }).where(eq(uploads.id, row.id));

  if (Number(row.sizeBytes) <= INLINE_HASH_MAX_BYTES) {
    await processUpload(row.id);
    const done = await loadUpload(caller, uploadId);
    if (done.status === 'failed') {
      throw new ApiError('validation_failed', `${done.error ?? 'The file could not be verified'}. It was removed.`, { hint: 'Check the file and start again with create_upload.' });
    }
    return statusOf(done);
  }
  // Very large file: the hash is computed by the background worker.
  const { mediaQueue } = await import('../jobs/queue.js');
  mediaQueue?.add('process-upload', { uploadId: row.id }, { attempts: 2, removeOnComplete: 200, removeOnFail: 200 })
    .catch((err: unknown) => logger.warn({ err, uploadId: row.id }, 'Could not queue upload processing'));
  return statusOf(await loadUpload(caller, uploadId));
}

/** Real SHA-256 of the stored file. Safe to run again: it only acts on a processing upload. */
export async function processUpload(uploadId: string): Promise<'ready' | 'failed' | 'skipped'> {
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (!row || row.status !== 'processing') return 'skipped';
  try {
    const info = await hashObject('creatives', row.r2Key, Number(row.sizeBytes) + 1024);
    if (!info) { await failUpload(row, 'The file is not in storage'); return 'failed'; }
    if (row.sha256 && row.sha256 !== info.sha256) { await failUpload(row, 'sha256 does not match the uploaded file'); return 'failed'; }
    await db.update(uploads).set({ status: 'ready', sha256: info.sha256, error: null, updatedAt: new Date() }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'processing')));
    return 'ready';
  } catch (err) {
    if (err instanceof ObjectTooLargeError) { await failUpload(row, 'The stored file is larger than declared'); return 'failed'; }
    logger.error({ err, uploadId }, 'Upload processing failed');
    await failUpload(row, 'Processing failed');
    return 'failed';
  }
}

/** A ready upload, for upload_asset. Still processing is retryable; anything else needs a new upload. */
export async function getReadyUpload(caller: Caller, uploadId: string): Promise<UploadRow> {
  const row = await loadUpload(caller, uploadId);
  if (row.status === 'ready') return row;
  if (row.status === 'processing' || row.status === 'uploading') {
    throw new ApiError('upload_incomplete', row.status === 'processing' ? 'The file is still being checked.' : 'The upload has not been completed.', {
      retryable: row.status === 'processing',
      hint: row.status === 'processing' ? 'Call complete_upload with the same uploadId until status is ready, then repeat upload_asset.' : 'Upload the file, then call complete_upload.',
    });
  }
  throw new ApiError('upload_incomplete', `This upload is ${row.status}${row.error ? `: ${row.error}` : ''}.`, { hint: 'Start again with create_upload.' });
}

export async function linkUploadToCreative(uploadId: string, creativeId: string): Promise<void> {
  await db.update(uploads).set({ creativeId, updatedAt: new Date() }).where(eq(uploads.id, uploadId));
}

/** Run by a repeating job: expire abandoned uploads (aborting any multipart upload so no parts are kept) and fail jobs stuck on processing. */
export async function sweepUploads(now: Date = new Date()): Promise<{ expired: number; failed: number }> {
  const stale = await db.select().from(uploads).where(and(inArray(uploads.status, ['created', 'uploading']), lt(uploads.expiresAt, now)));
  for (const row of stale) {
    await discardObject(row);
    await db.update(uploads).set({ status: 'expired', error: 'Not completed in time', updatedAt: now }).where(and(eq(uploads.id, row.id), inArray(uploads.status, ['created', 'uploading'])));
  }
  const stuck = await db.select().from(uploads).where(and(eq(uploads.status, 'processing'), lt(uploads.updatedAt, new Date(now.getTime() - PROCESSING_TIMEOUT_MS))));
  for (const row of stuck) await failUpload(row, 'Processing timed out');
  return { expired: stale.length, failed: stuck.length };
}

