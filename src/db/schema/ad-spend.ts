import { pgTable, uuid, varchar, integer, decimal, timestamp, date, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { campaigns } from './campaigns.js';

/**
 * Ad-spend rows ingested from Catchr, bucketed per day per campaign.
 *
 * Composite unique key (platform, authorization_id, account_id, campaign_id, date)
 * lets the hourly sync UPSERT idempotently — re-running the same window overwrites
 * the same rows rather than duplicating.
 *
 * `client_id` / `stato_campaign_id` stay NULL until Sam provides the
 * Catchr-campaign-id → Stato-client mapping (blocker #7 in handover doc).
 */
export const adSpend = pgTable('ad_spend', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: varchar('platform', { length: 50 }).notNull(),
  authorizationId: integer('authorization_id').notNull(),
  accountId: varchar('account_id', { length: 100 }).notNull(),
  accountName: varchar('account_name', { length: 255 }),
  campaignId: varchar('campaign_id', { length: 100 }).notNull().default(''),
  campaignName: varchar('campaign_name', { length: 500 }),
  date: date('date').notNull(),
  spend: decimal('spend', { precision: 14, scale: 6 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  clientId: uuid('client_id').references(() => clients.id),
  statoCampaignId: uuid('stato_campaign_id').references(() => campaigns.id),
  syncedAt: timestamp('synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ad_spend_unique_idx').on(t.platform, t.authorizationId, t.accountId, t.campaignId, t.date),
  index('ad_spend_date_idx').on(t.date),
  index('ad_spend_client_idx').on(t.clientId),
  index('ad_spend_platform_idx').on(t.platform),
]);

export type AdSpendRow = typeof adSpend.$inferSelect;
export type AdSpendInsert = typeof adSpend.$inferInsert;
