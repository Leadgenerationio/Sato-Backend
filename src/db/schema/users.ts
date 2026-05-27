import { pgTable, uuid, varchar, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { clients } from './clients.js';

export const userRoleEnum = pgEnum('user_role', [
  'owner', 'finance_admin', 'ops_manager', 'client', 'readonly',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('readonly'),
  businessId: uuid('business_id').references(() => businesses.id),
  clientId: uuid('client_id').references(() => clients.id),
  isActive: boolean('is_active').notNull().default(true),
  isPrimaryOwner: boolean('is_primary_owner').notNull().default(false),
  // Portal-side admin. Only client users with this flag may change the
  // agreement status from their dashboard (others see it read-only). The
  // role enum has no client-admin tier, so this per-user flag fills that gap.
  isClientAdmin: boolean('is_client_admin').notNull().default(false),
  notificationPreferences: jsonb('notification_preferences'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
