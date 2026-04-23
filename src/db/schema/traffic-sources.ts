import { pgTable, uuid, varchar, integer, decimal, timestamp, text, boolean, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const trafficSources = pgTable('traffic_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 100 }),
  accountId: varchar('account_id', { length: 100 }),
  // Catchr URL for ad-spend fetch per source (matches Leadreports.io pattern)
  catchrUrl: text('catchr_url'),
  isActive: boolean('is_active').notNull().default(true),
  totalSpend: decimal('total_spend', { precision: 12, scale: 2 }).notNull().default('0'),
  totalLeads: integer('total_leads').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('traffic_sources_campaign_idx').on(table.campaignId),
  index('traffic_sources_active_idx').on(table.isActive),
]);
