import { pgTable, uuid, varchar, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const bankAccounts = pgTable('bank_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  accountName: varchar('account_name', { length: 255 }).notNull(),
  customLabel: varchar('custom_label', { length: 255 }),
  bankName: varchar('bank_name', { length: 100 }),
  accountNumber: varchar('account_number', { length: 50 }),
  sortCode: varchar('sort_code', { length: 20 }),
  currency: varchar('currency', { length: 3 }).default('GBP'),
  currentBalance: decimal('current_balance', { precision: 14, scale: 2 }),
  lastSyncedAt: timestamp('last_synced_at'),
  externalAccountId: varchar('external_account_id', { length: 100 }),
  source: varchar('source', { length: 50 }).default('manual'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('bank_accounts_business_idx').on(table.businessId),
]);
