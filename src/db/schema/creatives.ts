import { pgTable, uuid, varchar, integer, timestamp, boolean, index, pgEnum } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { users } from './users.js';

// Migration 0031 (T2 — Sam, 2026-05-20): staff-side "Submit for approval"
// gate. Lifecycle is draft → sent_for_approval → (approved | rejected |
// changes_requested). Buyers see status != 'draft'; staff see everything.
// changes_requested allows the staff member to revise + re-submit (which
// returns the row to sent_for_approval).
export const creativeStatusEnum = pgEnum('creative_status', [
  'draft',
  'sent_for_approval',
  'approved',
  'rejected',
  'changes_requested',
]);

export type CreativeStatus =
  | 'draft'
  | 'sent_for_approval'
  | 'approved'
  | 'rejected'
  | 'changes_requested';

export const creatives = pgTable('creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  fileUrl: varchar('file_url', { length: 500 }).notNull(),
  type: varchar('type', { length: 50 }),
  version: integer('version').default(1),
  // Added in migration 0006: R2 storage details + soft-delete.
  r2Key: varchar('r2_key', { length: 500 }),
  sizeBytes: integer('size_bytes'),
  contentType: varchar('content_type', { length: 120 }),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  isDeleted: boolean('is_deleted').notNull().default(false),
  // Migration 0029 (creative review v2). Splits the portal review tab into
  // two cards — `media` for image/video, `copy_lp` for ad copy + landing
  // page URLs. The buyer signs off each card independently. Default 'media'
  // because legacy rows + most uploads are image/video.
  section: varchar('section', { length: 16 }).notNull().default('media'),
  // Migration 0031 (T2): submit-for-approval gate.
  status: creativeStatusEnum('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('creatives_campaign_idx').on(table.campaignId),
  index('creatives_is_deleted_idx').on(table.isDeleted),
  index('creatives_section_idx').on(table.section),
  index('creatives_status_idx').on(table.status),
]);

export type CreativeSection = 'media' | 'copy_lp';
