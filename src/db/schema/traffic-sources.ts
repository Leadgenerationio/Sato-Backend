import { pgTable, uuid, varchar, integer, decimal, timestamp, text, boolean, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const trafficSources = pgTable('traffic_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 100 }),
  accountId: varchar('account_id', { length: 100 }),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  // Catchr URL for ad-spend fetch per source (matches Leadreports.io pattern)
  catchrUrl: text('catchr_url'),
  isActive: boolean('is_active').default(true),
  totalSpend: decimal('total_spend', { precision: 12, scale: 2 }).default('0'),
  totalLeads: integer('total_leads').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('traffic_sources_campaign_idx').on(table.campaignId),
]);
