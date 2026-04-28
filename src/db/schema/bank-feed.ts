import { pgTable, uuid, varchar, text, decimal, timestamp, date, boolean, index, unique } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { users } from './users.js';

/**
 * Cost categories — buckets users define for their bank-feed transactions.
 *
 * Two top-level buckets ("fixed" / "one_off") match Sam's brief:
 * fixed = recurring (rent, salaries, software subscriptions);
 * one_off = ad-hoc (flights, equipment).
 */
export const costCategories = pgTable('cost_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  bucket: varchar('bucket', { length: 20 }).notNull(), // 'fixed' | 'one_off'
  color: varchar('color', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('cost_categories_business_idx').on(table.businessId),
  unique('cost_categories_business_name_unique').on(table.businessId, table.name),
]);

/**
 * Vendor → category rules. Created once when a user categorises a transaction
 * with "remember this vendor". Future syncs auto-tag matching transactions.
 *
 * matchType:
 *   'exact'    — vendorPattern must equal the transaction's vendorName/contact
 *   'contains' — case-insensitive substring match (good for "OCTOGLE LTD" ≈ "OCTOGLE")
 */
export const vendorCategoryRules = pgTable('vendor_category_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  vendorPattern: varchar('vendor_pattern', { length: 255 }).notNull(),
  matchType: varchar('match_type', { length: 20 }).notNull().default('contains'),
  categoryId: uuid('category_id').references(() => costCategories.id, { onDelete: 'cascade' }).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('vendor_rules_business_idx').on(table.businessId),
  index('vendor_rules_pattern_idx').on(table.vendorPattern),
]);

/**
 * Bank-feed transactions pulled from Xero. Idempotent on `xeroBankTransactionId`
 * so re-syncing the same period is a no-op.
 *
 * `amount` is signed: negative = money out (cost), positive = money in.
 * (Bank-feed view filters to negative for the "categorize costs" page.)
 */
export const bankTransactions = pgTable('bank_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  xeroBankTransactionId: varchar('xero_bank_transaction_id', { length: 50 }).notNull(),
  xeroAccountId: varchar('xero_account_id', { length: 50 }),
  date: date('date').notNull(),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  description: text('description'),
  vendorName: varchar('vendor_name', { length: 255 }),
  categoryId: uuid('category_id').references(() => costCategories.id, { onDelete: 'set null' }),
  ruleId: uuid('rule_id').references(() => vendorCategoryRules.id, { onDelete: 'set null' }),
  isAutoCategorized: boolean('is_auto_categorized').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('bank_tx_business_idx').on(table.businessId),
  index('bank_tx_date_idx').on(table.date),
  index('bank_tx_category_idx').on(table.categoryId),
  unique('bank_tx_business_xero_unique').on(table.businessId, table.xeroBankTransactionId),
]);
