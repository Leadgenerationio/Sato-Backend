import { pgTable, uuid, varchar, integer, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { users } from './users.js';

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
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('creatives_campaign_idx').on(table.campaignId),
  index('creatives_is_deleted_idx').on(table.isDeleted),
]);
