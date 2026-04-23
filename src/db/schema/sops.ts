import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const sops = pgTable('sops', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  category: varchar('category', { length: 50 }).notNull().default('Operations'),
  version: varchar('version', { length: 20 }).notNull().default('1.0'),
  author: varchar('author', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('sops_business_idx').on(table.businessId),
  index('sops_category_idx').on(table.category),
]);
