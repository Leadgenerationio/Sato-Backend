import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';
import { creatives } from './creatives.js';
import { campaigns } from './campaigns.js';
import { users } from './users.js';
import { apiKeys } from './api-keys.js';

// Migration 0055 (MCP connector). One row per ad a creative is used in. The
// campaign lives on the link so one ad account can feed several campaigns.
// platform uses the creatives.platform vocabulary (meta, taboola, google, tiktok).
export const creativeAdLinks = pgTable('creative_ad_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  creativeId: uuid('creative_id').references(() => creatives.id, { onDelete: 'cascade' }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(),
  platformAccountId: varchar('platform_account_id', { length: 100 }),
  platformCampaignId: varchar('platform_campaign_id', { length: 100 }),
  platformAdsetId: varchar('platform_adset_id', { length: 100 }),
  platformAdId: varchar('platform_ad_id', { length: 100 }),
  platformCreativeId: varchar('platform_creative_id', { length: 100 }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  /** active | unlinked. */
  status: varchar('status', { length: 10 }).notNull().default('active'),
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
  linkedByKeyId: uuid('linked_by_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
}, (t) => [
  index('creative_ad_links_creative_idx').on(t.creativeId),
  index('creative_ad_links_business_idx').on(t.businessId),
  index('creative_ad_links_campaign_idx').on(t.campaignId),
  uniqueIndex('creative_ad_links_ad_uq').on(t.platform, t.platformAdId).where(sql`status = 'active' AND platform_ad_id IS NOT NULL`),
]);

export type CreativeAdLinkRow = typeof creativeAdLinks.$inferSelect;
