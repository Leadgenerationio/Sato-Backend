import { pgTable, uuid, varchar, boolean, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';
import { users, userRoleEnum } from './users.js';

// Role Access Matrix (S7, migration 0043). One row per explicit choice; no
// row = allowed. Section keys live in src/config/sections.ts.
export const rolePermissions = pgTable('role_permissions', {
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }).notNull(),
  section: varchar('section', { length: 50 }).notNull(),
  role: userRoleEnum('role').notNull(),
  allowed: boolean('allowed').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.businessId, table.section, table.role] }),
]);

// Append-only audit of matrix changes.
export const rolePermissionChanges = pgTable('role_permission_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }).notNull(),
  section: varchar('section', { length: 50 }).notNull(),
  role: userRoleEnum('role').notNull(),
  allowedBefore: boolean('allowed_before').notNull(),
  allowedAfter: boolean('allowed_after').notNull(),
  changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
  changedAt: timestamp('changed_at').notNull().defaultNow(),
}, (table) => [
  index('role_permission_changes_business_idx').on(table.businessId, table.changedAt),
]);
