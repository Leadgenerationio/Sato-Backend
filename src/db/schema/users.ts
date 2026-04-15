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
  notificationPreferences: jsonb('notification_preferences'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
