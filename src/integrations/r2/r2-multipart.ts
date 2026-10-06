import { buildKey, getS3Client, isR2Configured, r2Bucket } from './r2-client.js';
import type { R2Folder } from './r2-types.js';

// S3-compatible multipart upload on R2, for files up to 4 GB (MCP spec v1.0).
// Parts go straight from the caller to storage through presigned URLs, so file
// bytes never pass through the API. Every part except the last must be at least
// 5 MiB (verified on the staging bucket).

export const MIN_PART_BYTES = 5 * 1024 * 1024;

function requireR2(): void {
  if (!isR2Configured()) throw new Error('Storage is not configured');
}

export async function createMultipart(folder: R2Folder, key: string, contentType: string): Promise<string> {
  requireR2();
  const { CreateMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  const res = await (await getS3Client()).send(new CreateMultipartUploadCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key), ContentType: contentType }));
  if (!res.UploadId) throw new Error('Storage did not return an upload id');
  return res.UploadId;
}

/** contentLength is signed into the URL, so the part cannot be any other size than the one create_upload promised. */
export async function presignUploadPart(folder: R2Folder, key: string, uploadId: string, partNumber: number, expiresInSeconds: number, contentLength?: number): Promise<string> {
  requireR2();
  const { UploadPartCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  return getSignedUrl(await getS3Client(), new UploadPartCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key), UploadId: uploadId, PartNumber: partNumber, ...(contentLength ? { ContentLength: contentLength } : {}) }), { expiresIn: expiresInSeconds });
}

export async function uploadPart(folder: R2Folder, key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
  requireR2();
  const { UploadPartCommand } = await import('@aws-sdk/client-s3');
  const res = await (await getS3Client()).send(new UploadPartCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key), UploadId: uploadId, PartNumber: partNumber, Body: body }));
  if (!res.ETag) throw new Error('Storage did not return an ETag for the part');
  return res.ETag;
}

export interface CompletedPart { partNumber: number; etag: string }

export async function completeMultipart(folder: R2Folder, key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
  requireR2();
  const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  await (await getS3Client()).send(new CompleteMultipartUploadCommand({
    Bucket: r2Bucket(), Key: buildKey(folder, key), UploadId: uploadId,
    MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
  }));
}

/** Idempotent: aborting an upload that is already gone is not an error. */
export async function abortMultipart(folder: R2Folder, key: string, uploadId: string): Promise<void> {
  if (!isR2Configured()) return;
  const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  try {
    await (await getS3Client()).send(new AbortMultipartUploadCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key), UploadId: uploadId }));
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchUpload') return;
    throw err;
  }
}

export interface ObjectHead { sizeBytes: number; contentType: string | null; etag: string | null }

export async function headObjectInfo(folder: R2Folder, key: string): Promise<ObjectHead | null> {
  requireR2();
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r = await (await getS3Client()).send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key) }));
    return { sizeBytes: r.ContentLength ?? 0, contentType: r.ContentType ?? null, etag: r.ETag ?? null };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** The first bytes of an object (a ranged read), to check the real file type. */
export async function readObjectHead(folder: R2Folder, key: string, bytes: number): Promise<Uint8Array | null> {
  requireR2();
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r = await (await getS3Client()).send(new GetObjectCommand({ Bucket: r2Bucket(), Key: buildKey(folder, key), Range: `bytes=0-${bytes - 1}` }));
    return r.Body ? await r.Body.transformToByteArray() : null;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/**
 * Copy an object to a new key, only if the source is still the exact object that
 * was checked (its ETag). Used to move a single-PUT upload to a key the caller
 * never had a URL for. Returns false when the source changed or is gone.
 */
export async function copyObjectIfUnchanged(folder: R2Folder, fromKey: string, toKey: string, etag: string): Promise<boolean> {
  requireR2();
  const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    await (await getS3Client()).send(new CopyObjectCommand({
      Bucket: r2Bucket(), Key: buildKey(folder, toKey),
      CopySource: encodeURIComponent(`${r2Bucket()}/${buildKey(folder, fromKey)}`).replace(/%2F/g, '/'),
      CopySourceIfMatch: etag,
    }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'PreconditionFailed' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 412 || e?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}
