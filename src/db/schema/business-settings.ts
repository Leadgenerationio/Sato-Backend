import { pgTable, uuid, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

// Migration 0053 (S4). Per-business settings the Owner can change without a
// deploy. `xeroTaxTypes` holds overrides only — see business-settings.service.
export const businessSettings = pgTable('business_settings', {
  businessId: uuid('business_id').primaryKey().references(() => businesses.id, { onDelete: 'cascade' }),
  xeroTaxTypes: jsonb('xero_tax_types').$type<Record<string, string>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
