import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  R2UploadOptions,
  R2UploadResult,
  R2SignedUrlOptions,
  R2Folder,
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
