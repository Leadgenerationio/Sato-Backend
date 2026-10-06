import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { db } from '../config/database.js';
import { uploads, type UploadRow } from '../db/schema/uploads.js';
import { creatives } from '../db/schema/creatives.js';
import { getSignedUploadUrl, hashObject, isR2Configured, deleteFile, ObjectTooLargeError } from '../integrations/r2/r2-client.js';
import { abortMultipart, completeMultipart, copyObjectIfUnchanged, createMultipart, headObjectInfo, presignUploadPart, readObjectHead, type CompletedPart } from '../integrations/r2/r2-multipart.js';
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
/** Hash inside complete_upload up to this size; larger files hash in the background (a 1 GB hash can outlast an MCP client's timeout). */
const INLINE_HASH_MAX_BYTES = 100 * MiB;
const PROCESSING_TIMEOUT_MS = 45 * 60 * 1000;
/** An upload that is ready but never used by upload_asset is removed after this. */
const READY_UNUSED_TTL_MS = 24 * 60 * 60 * 1000;
/** Uploads a business can have open (created or uploading) at once. */
const MAX_OPEN_UPLOADS = 50;
/** A single-PUT file is copied here once checked: a key the caller never had a URL for. */
const VERIFIED_PREFIX = 'verified-';
/** After its URL expired, an upload's original key is cleaned for this long (several sweeper runs). */
const ORIGINAL_SWEEP_WINDOW_MS = 60 * 60 * 1000;
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
  const [open] = await db.select({ n: count() }).from(uploads).where(and(eq(uploads.businessId, caller.businessId), inArray(uploads.status, ['created', 'uploading'])));
  if ((open?.n ?? 0) >= MAX_OPEN_UPLOADS) {
    throw new ApiError('rate_limited', `There are already ${MAX_OPEN_UPLOADS} uploads open for this business.`, {
      retryable: true, hint: 'Finish them with complete_upload, or wait until they expire (6 hours), then start this one again.',
    });
  }

  const key = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(input.filename)}`;
  const mode: 'single' | 'multipart' = input.sizeBytes <= SINGLE_MAX_BYTES ? 'single' : 'multipart';
  const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000);
  let multipartId: string | null = null;
  let result: Pick<CreateUploadResult, 'uploadUrl' | 'headers' | 'partSize' | 'parts'>;

  if (mode === 'single') {
    result = { uploadUrl: await getSignedUploadUrl({ folder: 'creatives', key, contentType: input.contentType, contentLength: input.sizeBytes, expiresInSeconds: URL_TTL_SECONDS }), headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.sizeBytes) }, partSize: null, parts: null };
  } else {
    const partCount = Math.ceil(input.sizeBytes / PART_BYTES);
    if (partCount > MAX_PARTS) throw new ApiError('file_too_large', 'That file needs more parts than storage allows.');
    multipartId = await createMultipart('creatives', key, input.contentType);
    const parts: NonNullable<CreateUploadResult['parts']> = [];
    for (let n = 1; n <= partCount; n++) {
      const bytes = n < partCount ? PART_BYTES : input.sizeBytes - PART_BYTES * (partCount - 1);
      parts.push({ partNumber: n, url: await presignUploadPart('creatives', key, multipartId, n, URL_TTL_SECONDS, bytes), bytes });
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
    if (row.multipartUploadId) await abortMultipart('creatives', row.r2Key, row.multipartUploadId);
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
  // Once assembled, multipartUploadId is cleared and a retry needs no parts.
  if (row.mode === 'multipart' && row.multipartUploadId && (!parts || parts.length === 0)) {
    throw new ApiError('validation_failed', 'parts is required for a multipart upload: the partNumber and ETag of every part.', { fields: [{ field: 'parts', message: 'List every uploaded part with its etag' }] });
  }

  // Claim it, so two calls at once cannot both finish it.
  const [claimed] = await db.update(uploads).set({ status: 'processing', updatedAt: new Date() }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'uploading'))).returning();
  if (!claimed) return statusOf((await loadUpload(caller, uploadId)));

  try {
    return await verifyClaimed(caller, row, parts);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Storage or the database failed in a way that says nothing about the file: keep the file and let the caller retry.
    logger.error({ err, uploadId: row.id }, 'complete_upload failed unexpectedly; upload left retryable');
    await db.update(uploads).set({ status: 'uploading', updatedAt: new Date() }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'processing')));
    throw new ApiError('internal_error', 'Storage could not be reached just now. The file was not removed.', {
      retryable: true, hint: 'Call complete_upload again with the same arguments.',
    });
  }
}

async function verifyClaimed(caller: Caller, start: UploadRow, parts?: CompletedPart[]): Promise<UploadStatus> {
  let row = start;
  const uploadId = row.id;
  if (row.mode === 'multipart' && row.multipartUploadId) {
    try {
      await completeMultipart('creatives', row.r2Key, row.multipartUploadId, parts!);
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'NoSuchUpload') {
        await db.update(uploads).set({ status: 'failed', error: 'The multipart upload no longer exists', updatedAt: new Date() }).where(eq(uploads.id, row.id));
        throw new ApiError('upload_incomplete', 'Storage no longer has this upload.', { hint: 'Start again with create_upload.' });
      }
      if (!['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'MalformedXML'].includes(name)) throw err; // not about the parts: retry as is
      // Missing or too-small parts: let the caller fix it and try again.
      await db.update(uploads).set({ status: 'uploading', updatedAt: new Date() }).where(eq(uploads.id, row.id));
      throw new ApiError('upload_incomplete', 'Some parts are missing, wrong or too small.', {
        hint: 'Upload every part from parts[] (each except the last must be the full part size), then send every partNumber with the ETag the storage returned.',
        details: { storageError: name },
      });
    }
  }

  if (row.mode === 'multipart' && row.multipartUploadId) {
    // The upload id is used up by assembling. Record that, so a retry after a later storage error goes straight to the
    // checks instead of completing an upload id that no longer exists (which would fail the upload and lose the file).
    await db.update(uploads).set({ multipartUploadId: null, updatedAt: new Date() }).where(eq(uploads.id, row.id));
    row = { ...row, multipartUploadId: null };
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

  // A single-PUT URL stays valid for hours and the caller holds it. Copy the checked object (only if it is still the
  // exact one just measured) to a key nobody has a URL for, and work on that copy. A multipart upload id is consumed
  // by completing it, so it needs no copy.
  if (row.mode === 'single' && !row.r2Key.startsWith(VERIFIED_PREFIX)) {
    const finalKey = `${VERIFIED_PREFIX}${row.r2Key}`; // the original key stays recoverable from it, for the sweeper
    if (!head.etag) throw new Error('Storage did not return an ETag');
    if (!(await copyObjectIfUnchanged('creatives', row.r2Key, finalKey, head.etag))) {
      await db.update(uploads).set({ status: 'uploading', updatedAt: new Date() }).where(eq(uploads.id, row.id));
      throw new ApiError('upload_incomplete', 'The file changed while it was being checked.', { retryable: true, hint: 'Do not send it again. Call complete_upload again.' });
    }
    const oldKey = row.r2Key;
    await db.update(uploads).set({ r2Key: finalKey, updatedAt: new Date() }).where(eq(uploads.id, row.id));
    row = { ...row, r2Key: finalKey };
    await deleteFile('creatives', oldKey).catch((err: unknown) => logger.warn({ err, uploadId: row.id }, 'Could not remove the original single-PUT object'));
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
  // Large file: the hash is computed by the background worker.
  const { mediaQueue } = await import('../jobs/queue.js');
  mediaQueue?.add('process-upload', { uploadId: row.id }, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 200, removeOnFail: 200 })
    .catch((err: unknown) => logger.warn({ err, uploadId: row.id }, 'Could not queue upload processing'));
  return statusOf(await loadUpload(caller, uploadId));
}

/** Real SHA-256 of the stored file. Safe to run again: it only acts on a processing upload. Only a real verification failure removes the file; any other error is rethrown so the job retries. */
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
    // A storage or database error says nothing about the file: keep it and let the job retry (or the caller call again).
    logger.error({ err, uploadId }, 'Upload processing hit an error; the file is kept for a retry');
    throw err;
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

const FILING = 'filing';
const FILING_STALE_MS = 10 * 60 * 1000;

/**
 * Claim a ready, unused upload for filing, in the database, so two API instances cannot both file it. The marker lives
 * in `error` while the claim is held (a ready upload has no error); a claim older than 10 minutes is taken as dead.
 */
export async function claimUploadForFiling(uploadId: string): Promise<boolean> {
  const [row] = await db.update(uploads).set({ error: FILING, updatedAt: new Date() }).where(and(
    eq(uploads.id, uploadId), eq(uploads.status, 'ready'), isNull(uploads.creativeId),
    or(isNull(uploads.error), and(eq(uploads.error, FILING), lt(uploads.updatedAt, new Date(Date.now() - FILING_STALE_MS)))),
  )).returning({ id: uploads.id });
  return Boolean(row);
}

/** Give a claim back when filing failed, so the caller can try again. */
export async function releaseUploadClaim(uploadId: string): Promise<void> {
  await db.update(uploads).set({ error: null, updatedAt: new Date() }).where(and(eq(uploads.id, uploadId), eq(uploads.error, FILING), isNull(uploads.creativeId)));
}

/** Marks an upload as used and releases the claim. Only the first call counts: a used upload is never pointed at a second creative. */
export async function linkUploadToCreative(uploadId: string, creativeId: string): Promise<void> {
  await db.update(uploads).set({ creativeId, error: null, updatedAt: new Date() }).where(and(eq(uploads.id, uploadId), isNull(uploads.creativeId)));
}

/** For the worker: an upload whose processing ran out of attempts fails with a clear reason (and its object is removed). */
export async function failUploadById(uploadId: string, message: string): Promise<void> {
  const [row] = await db.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.status, 'processing')));
  if (row) await failUpload(row, message);
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
  // Verified but never used by upload_asset: do not keep the file forever.
  const unused = await db.select().from(uploads).where(and(eq(uploads.status, 'ready'), isNull(uploads.creativeId), lt(uploads.updatedAt, new Date(now.getTime() - READY_UNUSED_TTL_MS))));
  for (const row of unused) {
    await discardObject(row);
    await db.update(uploads).set({ status: 'expired', error: 'Never used by upload_asset', updatedAt: now }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'ready'), isNull(uploads.creativeId)));
  }
  // A refused upload whose object could not be removed at the time: try once more a day later (removing a missing object is not an error).
  const leftovers = await db.select().from(uploads).where(and(eq(uploads.status, 'failed'), lt(uploads.updatedAt, new Date(now.getTime() - READY_UNUSED_TTL_MS))));
  for (const row of leftovers) {
    await discardObject(row);
    await db.update(uploads).set({ status: 'aborted', updatedAt: now }).where(and(eq(uploads.id, row.id), eq(uploads.status, 'failed')));
  }
  // The single-PUT URL can write to the original key until it expires, even after the copy. Remove whatever was
  // written there once the URL is dead (the window is wider than the sweep interval, so no run is missed).
  const copied = await db.select().from(uploads).where(and(eq(uploads.mode, 'single'), lt(uploads.expiresAt, now), gt(uploads.expiresAt, new Date(now.getTime() - ORIGINAL_SWEEP_WINDOW_MS))));
  for (const row of copied) {
    if (!row.r2Key.startsWith(VERIFIED_PREFIX)) continue;
    await deleteFile('creatives', row.r2Key.slice(VERIFIED_PREFIX.length)).catch((err: unknown) => logger.warn({ err, uploadId: row.id }, 'Could not remove an original single-PUT object'));
  }
  // A verified video whose poster job never ran or ran out of attempts: the file itself is checked, so settle it as ready.
  await db.update(creatives).set({ fileStatus: 'ready' })
    .where(and(eq(creatives.fileStatus, 'processing'), eq(creatives.source, 'mcp'), lt(creatives.updatedAt, new Date(now.getTime() - PROCESSING_TIMEOUT_MS))));
  return { expired: stale.length + unused.length, failed: stuck.length };
}

