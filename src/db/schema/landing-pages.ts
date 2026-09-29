import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { clients } from './clients.js';

// Created in 0000 but unused until migration 0045 (creative library): landing
// pages are now per-CLIENT records. normalised_url (normaliseLandingUrl) is
// unique per client so the same page arriving from two ads is one row.
// campaign_id is optional since 0045.
export const landingPages = pgTable('landing_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
  url: varchar('url', { length: 500 }).notNull(),
  normalisedUrl: varchar('normalised_url', { length: 500 }),
  title: varchar('title', { length: 255 }),
  screenshotUrl: varchar('screenshot_url', { length: 500 }),
  screenshotKey: varchar('screenshot_key', { length: 500 }),
  status: varchar('status', { length: 50 }).default('active'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  index('landing_pages_client_idx').on(t.clientId),
]);

export type LandingPageRow = typeof landingPages.$inferSelect;
