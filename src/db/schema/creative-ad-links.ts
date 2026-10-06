import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';
import { creatives } from './creatives.js';
import { clients } from './clients.js';
import { landingPages } from './landing-pages.js';
import { campaigns } from './campaigns.js';
import { users } from './users.js';
import { apiKeys } from './api-keys.js';

// Migration 0055 (MCP connector). One row per ad a creative is used in. The
// campaign lives on the link so one ad account can feed several campaigns.
// platform uses the creatives.platform vocabulary (meta, taboola, google, tiktok).
export type CreativeAdLinkStatus = 'active' | 'paused' | 'removed' | 'unknown';
export type CreativeAdLinkSource = 'mcp' | 'api' | 'sync' | 'portal';

export const creativeAdLinks = pgTable('creative_ad_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  creativeId: uuid('creative_id').references(() => creatives.id, { onDelete: 'cascade' }).notNull(),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  platform: varchar('platform', { length: 20 }).notNull(),
  platformAccountId: varchar('platform_account_id', { length: 100 }),
  platformCampaignId: varchar('platform_campaign_id', { length: 100 }),
  platformCampaignName: varchar('platform_campaign_name', { length: 255 }),
  platformAdsetId: varchar('platform_adset_id', { length: 100 }),
  platformAdsetName: varchar('platform_adset_name', { length: 255 }),
  platformAdId: varchar('platform_ad_id', { length: 100 }),
  platformAdName: varchar('platform_ad_name', { length: 255 }),
  platformCreativeId: varchar('platform_creative_id', { length: 100 }),
  /** Meta image hash or video ID, Google asset resource name, TikTok video or image ID. */
  platformAssetId: varchar('platform_asset_id', { length: 255 }),
  landingPageId: uuid('landing_page_id').references(() => landingPages.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 10 }).$type<CreativeAdLinkStatus>().notNull().default('active'),
  source: varchar('source', { length: 10 }).$type<CreativeAdLinkSource>().notNull().default('api'),
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
  createdByKeyId: uuid('created_by_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** A wrong link is removed, never deleted. */
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  index('creative_ad_links_creative_idx').on(t.creativeId),
  index('creative_ad_links_business_idx').on(t.businessId),
  index('creative_ad_links_campaign_idx').on(t.campaignId),
  uniqueIndex('creative_ad_links_ad_uq').on(t.platform, t.platformAdId).where(sql`status <> 'removed' AND platform_ad_id IS NOT NULL`),
]);

export type CreativeAdLinkRow = typeof creativeAdLinks.$inferSelect;
