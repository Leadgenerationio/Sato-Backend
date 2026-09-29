import { pgTable, uuid, timestamp, text, integer } from 'drizzle-orm/pg-core';
import { clientAdAccounts } from './client-ad-accounts.js';

// Migration 0047 (plan phase 3): per-ad-account state of the scheduled
// Meta / Taboola creative sync. See the migration for why it's its own table.
export const adAccountSyncState = pgTable('ad_account_sync_state', {
  clientAdAccountId: uuid('client_ad_account_id').primaryKey()
    .references(() => clientAdAccounts.id, { onDelete: 'cascade' }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  cursorSince: timestamp('cursor_since', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  adsSeen: integer('ads_seen').notNull().default(0),
  creativesCreated: integer('creatives_created').notNull().default(0),
  creativesUpdated: integer('creatives_updated').notNull().default(0),
  creativesFailed: integer('creatives_failed').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AdAccountSyncStateRow = typeof adAccountSyncState.$inferSelect;
