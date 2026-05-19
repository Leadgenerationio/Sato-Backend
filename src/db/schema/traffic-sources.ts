import { pgTable, uuid, varchar, integer, decimal, timestamp, text, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const trafficSources = pgTable('traffic_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 100 }),
  /** Primary / legacy Catchr account id — kept for back-compat with rows
   *  created before the multi-account split. New rows can leave this null
   *  and put every account into `accountIds` instead. */
  accountId: varchar('account_id', { length: 100 }),
  /** Additional Catchr account ids whose spend should roll up under this
   *  source row. JSONB array of strings. listSourcesForCampaign() unions
   *  this with `accountId` when summing ad_spend. */
  accountIds: jsonb('account_ids').$type<string[]>().notNull().default([]),
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
