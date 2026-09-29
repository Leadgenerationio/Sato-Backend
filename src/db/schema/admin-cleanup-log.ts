import { pgTable, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// S8 / N6 (migration 0049): one row per "Apply" on Settings → Clean up, so
// every deactivation, role change and archive the Owner made is traceable.
export const adminCleanupLog = pgTable('admin_cleanup_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id'),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  changes: jsonb('changes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('admin_cleanup_log_business_idx').on(table.businessId, table.createdAt),
]);
