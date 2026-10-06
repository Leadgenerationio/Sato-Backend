import { pgTable, uuid, varchar, integer, bigint, timestamp, boolean, index, pgEnum, text, decimal, char } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { apiKeys } from './api-keys.js';
import { clients } from './clients.js';
import { landingPages } from './landing-pages.js';
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
  // Nullable since migration 0045 (creative library): a creative synced from
  // Meta/Taboola may belong to a client with no campaign yet.
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  name: varchar('name', { length: 255 }).notNull(),
  // Nullable since migration 0055: copy-only assets (type = 'copy') have no file.
  fileUrl: varchar('file_url', { length: 500 }),
  type: varchar('type', { length: 50 }),
  version: integer('version').default(1),
  // Added in migration 0006: R2 storage details + soft-delete.
  r2Key: varchar('r2_key', { length: 500 }),
  // bigint since migration 0055 (a 4 GB video overflows a 32-bit integer).
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
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
  // Migration 0045 (creative library — docs/creative-library-and-api-plan.md).
  // client_id NULL = shared on its campaign: shows under every buyer.
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
  // 'meta' | 'taboola' | 'google' | 'tiktok' | 'manual'
  platform: varchar('platform', { length: 20 }),
  platformAccountId: varchar('platform_account_id', { length: 100 }),
  platformAdId: varchar('platform_ad_id', { length: 100 }),
  platformCreativeId: varchar('platform_creative_id', { length: 100 }),
  platformCampaignId: varchar('platform_campaign_id', { length: 100 }),
  platformCampaignName: varchar('platform_campaign_name', { length: 255 }),
  landingPageId: uuid('landing_page_id').references(() => landingPages.id, { onDelete: 'set null' }),
  headline: text('headline'),
  bodyText: text('body_text'),
  width: integer('width'),
  height: integer('height'),
  durationS: decimal('duration_s', { precision: 8, scale: 2 }),
  sha256: char('sha256', { length: 64 }),
  thumbnailKey: varchar('thumbnail_key', { length: 500 }),
  firstSeen: timestamp('first_seen', { withTimezone: true }),
  lastSeen: timestamp('last_seen', { withTimezone: true }),
  // Migration 0055 (MCP connector): archive without deleting the file, upload
  // processing state, where the row came from, which API key made it, tags.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
  archiveReason: varchar('archive_reason', { length: 255 }),
  /** processing -> ready | failed. */
  fileStatus: varchar('file_status', { length: 16 }).notNull().default('ready'),
  /** portal | api | mcp | sync. */
  source: varchar('source', { length: 16 }).notNull().default('portal'),
  createdByKeyId: uuid('created_by_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('creatives_client_idx').on(table.clientId),
  index('creatives_sha256_idx').on(table.sha256),
  index('creatives_campaign_idx').on(table.campaignId),
  index('creatives_is_deleted_idx').on(table.isDeleted),
  index('creatives_section_idx').on(table.section),
  index('creatives_status_idx').on(table.status),
  index('creatives_archived_at_idx').on(table.archivedAt),
]);

export type CreativeSection = 'media' | 'copy_lp';
