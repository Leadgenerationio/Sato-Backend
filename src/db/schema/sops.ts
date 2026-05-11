import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';

export interface SopScreenshot {
  key: string;          // R2 object key returned by the presigned-upload flow
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;   // ISO timestamp
  uploadedBy?: string;
  caption?: string;
}

export const sops = pgTable('sops', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  category: varchar('category', { length: 50 }).notNull().default('Operations'),
  version: varchar('version', { length: 20 }).notNull().default('1.0'),
  author: varchar('author', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  /** Single Loom recording embedded on the SOP detail page. */
  loomUrl: varchar('loom_url', { length: 500 }),
  /** Uploaded screenshots referenced inline in the SOP body. */
  screenshots: jsonb('screenshots').$type<SopScreenshot[]>().notNull().default(sql`'[]'::jsonb`),
  /** Multi-tag categorisation (e.g. "Software", "Creative", "Solar"). */
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('sops_business_idx').on(table.businessId),
  index('sops_category_idx').on(table.category),
]);
