import { pgTable, uuid, varchar, integer, timestamp } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const creatives = pgTable('creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  fileUrl: varchar('file_url', { length: 500 }).notNull(),
  type: varchar('type', { length: 50 }),
  version: integer('version').default(1),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
