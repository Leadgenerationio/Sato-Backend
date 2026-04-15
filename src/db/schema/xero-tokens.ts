import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const xeroTokens = pgTable('xero_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  accessToken: varchar('access_token', { length: 2000 }).notNull(),
  refreshToken: varchar('refresh_token', { length: 2000 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  tenantId: varchar('tenant_id', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
