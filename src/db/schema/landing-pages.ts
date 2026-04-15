import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const landingPages = pgTable('landing_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  screenshotUrl: varchar('screenshot_url', { length: 500 }),
  status: varchar('status', { length: 50 }).default('active'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
