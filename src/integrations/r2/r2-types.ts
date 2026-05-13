// Canonical list of R2 folder names. The TS type below + the zod tuple
// below are both derived from this array so callers never need to mirror
// the list. Add a new folder here once and everything that validates against
// it (upload.routes presign schema, agreement.controller r2SourceFolder enum,
// any future routes) gets the new value automatically.
export const R2_FOLDERS = [
  'invoices',
  'agreements',
  'creatives',
  'landing-pages',
  'sops',
  'misc',
] as const;

export type R2Folder = (typeof R2_FOLDERS)[number];

/** Mutable copy of R2_FOLDERS shaped as a `[head, ...tail]` tuple — what
 *  `z.enum()` expects. Use this in zod schemas:
 *    `z.enum(R2_FOLDER_TUPLE).optional()`
 *  instead of hand-typing the literal list. */
export const R2_FOLDER_TUPLE: [R2Folder, ...R2Folder[]] = [...R2_FOLDERS] as [R2Folder, ...R2Folder[]];

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
