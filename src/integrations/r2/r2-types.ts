export type R2Folder = 'invoices' | 'agreements' | 'creatives' | 'landing-pages' | 'misc';

export interface R2UploadOptions {
  folder: R2Folder;
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface R2UploadResult {
  key: string;
  bucket: string;
  publicUrl: string;
  size: number;
}

export interface R2SignedUrlOptions {
  folder: R2Folder;
  key: string;
  expiresInSeconds?: number;
  contentType?: string;
}
