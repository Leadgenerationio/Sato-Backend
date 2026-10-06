import { pgTable, uuid, varchar, bigint, text, char, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';
import { creatives } from './creatives.js';
import { users } from './users.js';
import { apiKeys } from './api-keys.js';

// Migration 0055 (MCP connector). One row per direct / multipart / URL upload,
// so a job stuck on processing can be swept and an abandoned multipart aborted.
export type UploadMode = 'single' | 'multipart' | 'url';
export type UploadStatus = 'created' | 'uploading' | 'processing' | 'ready' | 'failed' | 'aborted' | 'expired';

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdByKeyId: uuid('created_by_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  filename: varchar('filename', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 120 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: char('sha256', { length: 64 }),
  r2Key: varchar('r2_key', { length: 500 }).notNull(),
  mode: varchar('mode', { length: 10 }).$type<UploadMode>().notNull(),
  multipartUploadId: varchar('multipart_upload_id', { length: 500 }),
  partSize: bigint('part_size', { mode: 'number' }),
  status: varchar('status', { length: 12 }).$type<UploadStatus>().notNull().default('created'),
  error: text('error'),
  creativeId: uuid('creative_id').references(() => creatives.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('uploads_business_idx').on(t.businessId),
  index('uploads_open_idx').on(t.status, t.updatedAt).where(sql`status IN ('created', 'uploading', 'processing')`),
]);

export type UploadRow = typeof uploads.$inferSelect;
