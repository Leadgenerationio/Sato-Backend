import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  R2_FOLDERS,
  type R2UploadOptions,
  type R2UploadResult,
  type R2SignedUrlOptions,
  type R2Folder,
} from './r2-types.js';

/**
 * Cloudflare R2 is S3-wire-compatible. This client dynamically imports
 * @aws-sdk/client-s3 so the dependency is optional until R2 is used.
 * Falls back to a no-op mock when R2 creds are not configured.
 */

export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    (process.env.R2_BUCKET || env.R2_BUCKET) &&
    (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID)
  );
}

function buildEndpoint(): string {
  const endpoint = process.env.R2_ENDPOINT || env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID || env.R2_ACCOUNT_ID;
  if (endpoint) return endpoint;
  if (accountId) return `https://${accountId}.r2.cloudflarestorage.com`;
  throw new Error('R2_ENDPOINT or R2_ACCOUNT_ID must be set');
}

function buildKey(folder: R2Folder, key: string): string {
  const safe = key.replace(/^\/+/, '');
  return `${folder}/${safe}`;
}

/**
 * Recover the (folder, key) pair from a stored R2 file URL. Used to generate
 * a fresh signed download URL for a creative without trusting any single
 * caller-provided folder — staff and the portal each saw different folder
 * names for the same row before this. The URL written at upload time always
 * contains the real path, so it's the authoritative source.
 *
 * Handles both URL shapes the SDK produces:
 *   path-style (forcePathStyle true) — `/<bucket>/<folder>/<key>`
 *   vhost-style                       — `/<folder>/<key>`
 *
 * We find the first path segment matching a canonical R2_FOLDERS entry and
 * take everything after it as the key. Returns null if the URL doesn't
 * contain a recognised folder — callers should fall back to ('misc', r2Key)
 * for legacy rows where every creative landed in misc/ before this fix.
 */
export function parseR2LocationFromFileUrl(
  fileUrl: string | null | undefined,
): { folder: R2Folder; key: string } | null {
  if (!fileUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    return null;
  }
  const segments = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const folderIdx = segments.findIndex((s) => (R2_FOLDERS as readonly string[]).includes(s));
  if (folderIdx === -1) return null;
  const key = segments.slice(folderIdx + 1).join('/');
  if (!key) return null;
  return { folder: segments[folderIdx] as R2Folder, key };
}

function buildPublicUrl(fullKey: string): string {
  const publicBase = process.env.R2_PUBLIC_URL || env.R2_PUBLIC_URL;
  if (publicBase) return `${publicBase.replace(/\/$/, '')}/${fullKey}`;
  if (!isR2Configured()) {
    // Mock mode — no credentials means no real endpoint; return a predictable local URL.
    const bucket = process.env.R2_BUCKET || env.R2_BUCKET || 'mock-bucket';
    return `mock://${bucket}/${fullKey}`;
  }
  const bucket = process.env.R2_BUCKET || env.R2_BUCKET;
  return `${buildEndpoint().replace(/\/$/, '')}/${bucket}/${fullKey}`;
}

async function getS3Client() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: buildEndpoint(),
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    // Cloudflare R2 doesn't fully support AWS SDK v3's new default behavior
    // of auto-adding CRC32 checksum headers. The browser PUT then fails with
    // signature mismatch because the presigned URL signs an empty CRC32.
    // Force WHEN_REQUIRED so checksums only add when caller explicitly asks.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function uploadFile(opts: R2UploadOptions): Promise<R2UploadResult> {
  const fullKey = buildKey(opts.folder, opts.key);
  const size = typeof opts.body === 'string' ? Buffer.byteLength(opts.body) : opts.body.length;
  const bucket = process.env.R2_BUCKET || env.R2_BUCKET || 'mock-bucket';

  if (!isR2Configured()) {
    logger.warn({ fullKey, size }, 'R2 MOCK — not configured, skipping upload');
    return { key: fullKey, bucket, publicUrl: buildPublicUrl(fullKey), size };
  }

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET || env.R2_BUCKET,
      Key: fullKey,
      Body: opts.body as any,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl,
      Metadata: opts.metadata,
    }),
  );

  logger.info({ fullKey, size, contentType: opts.contentType }, 'R2 upload complete');
  return { key: fullKey, bucket: env.R2_BUCKET, publicUrl: buildPublicUrl(fullKey), size };
}

/**
 * HEAD the object to confirm it exists before we hand out a signed URL.
 * Without this, a stale/mistyped r2_key still signs successfully and the
 * caller gets R2's `<Error><Code>NoSuchKey/></Error>` XML when they open
 * the URL — same UX failure mode as the original ExpiredRequest bug.
 *
 * Returns `true` in mock mode (no creds) so dev/test paths don't fail.
 */
export async function objectExists(folder: R2Folder, key: string): Promise<boolean> {
  if (!isR2Configured()) return true;
  const fullKey = buildKey(folder, key);
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: fullKey }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export async function getSignedDownloadUrl(opts: R2SignedUrlOptions): Promise<string> {
  const fullKey = buildKey(opts.folder, opts.key);
  const expiresIn = opts.expiresInSeconds ?? 900;

  if (!isR2Configured()) {
    logger.warn({ fullKey }, 'R2 MOCK — returning public URL instead of signed URL');
    return buildPublicUrl(fullKey);
  }

  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await getS3Client();

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: fullKey }),
    { expiresIn },
  );
}

export async function getSignedUploadUrl(opts: R2SignedUrlOptions): Promise<string> {
  const fullKey = buildKey(opts.folder, opts.key);
  const expiresIn = opts.expiresInSeconds ?? 900;

  if (!isR2Configured()) {
    logger.warn({ fullKey }, 'R2 MOCK — cannot generate signed upload URL without creds');
    return `mock://upload/${fullKey}`;
  }

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await getS3Client();

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET || env.R2_BUCKET,
      Key: fullKey,
      ContentType: opts.contentType,
    }),
    { expiresIn },
  );
}

/**
 * Download a stored object back as a Buffer. Used when the backend needs to
 * forward an already-uploaded file to a third party (e.g., agreements page
 * uploads a PDF to R2 first, then we download it here to forward to SignNow).
 */
export async function downloadFile(folder: R2Folder, key: string): Promise<Buffer> {
  const fullKey = buildKey(folder, key);

  if (!isR2Configured()) {
    throw new Error(`R2 not configured — cannot download ${fullKey}`);
  }

  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  const res = await client.send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: fullKey }),
  );
  if (!res.Body) throw new Error(`R2 download returned empty body for ${fullKey}`);
  // AWS SDK v3 returns a stream; collect into a Buffer.
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteFile(folder: R2Folder, key: string): Promise<void> {
  const fullKey = buildKey(folder, key);

  if (!isR2Configured()) {
    logger.warn({ fullKey }, 'R2 MOCK — skipping delete');
    return;
  }

  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();

  await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: fullKey }));
  logger.info({ fullKey }, 'R2 delete complete');
}
