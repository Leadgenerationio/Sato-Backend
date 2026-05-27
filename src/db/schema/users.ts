import { pgTable, uuid, varchar, timestamp, boolean, jsonb, pgEnum, text } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { clients } from './clients.js';

// Sam (2026-05-27 portal meeting): 'client_admin' added so each client's
// own admin can manage their portal users + mark agreements signed
// externally — replaces Sam being the bottleneck. Day-1 default: the
// earliest portal user per client is auto-promoted (see migration 0035).
export const userRoleEnum = pgEnum('user_role', [
  'owner', 'finance_admin', 'ops_manager', 'client', 'client_admin', 'readonly',
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
  notificationPreferences: jsonb('notification_preferences'),
  // Sam (2026-05-27 portal meeting): per-portal-user tab visibility.
  // null = full access (backward compat). non-null = only these tabs +
  // dashboard + account. client_admin ignores this column.
  allowedTabs: text('allowed_tabs').array(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
