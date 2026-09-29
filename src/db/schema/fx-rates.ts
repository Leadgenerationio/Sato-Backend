import { pgTable, uuid, varchar, decimal, date, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Feedback M3 (29 Sep 2026): daily ECB reference rates, base GBP. 1 GBP =
// `rate` units of `quote` on `rateDate`. Migration 0050.
export const fxRates = pgTable('fx_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  base: varchar('base', { length: 3 }).notNull(),
  quote: varchar('quote', { length: 3 }).notNull(),
  rate: decimal('rate', { precision: 18, scale: 8 }).notNull(),
  rateDate: date('rate_date').notNull(),
  source: varchar('source', { length: 50 }).notNull(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('fx_rates_pair_date_uq').on(table.base, table.quote, table.rateDate),
]);
