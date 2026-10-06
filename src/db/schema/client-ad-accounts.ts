import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { clients } from './clients.js';
import { campaigns } from './campaigns.js';
import { users } from './users.js';

// Migration 0041 (Sam S13, 2026-09-29): which client owns each ad account.
// Matched on (platform, account_id) only — platform is canonicalizePlatform()
// output. See the migration for why campaign → client can't answer this.
export const clientAdAccounts = pgTable('client_ad_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  platform: varchar('platform', { length: 50 }).notNull(),
  accountId: varchar('account_id', { length: 100 }).notNull(),
  accountName: varchar('account_name', { length: 255 }),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }).notNull(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  currency: varchar('currency', { length: 3 }),
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
  // Migration 0055: a confirmed move from another client is recorded here.
  movedFromClientId: uuid('moved_from_client_id').references(() => clients.id, { onDelete: 'set null' }),
  movedAt: timestamp('moved_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  uniqueIndex('client_ad_accounts_platform_account_uq').on(t.platform, t.accountId),
  index('client_ad_accounts_client_idx').on(t.clientId),
  index('client_ad_accounts_business_idx').on(t.businessId),
]);

export type ClientAdAccountRow = typeof clientAdAccounts.$inferSelect;
