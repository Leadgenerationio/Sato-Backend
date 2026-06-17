import { pgTable, uuid, varchar, text, boolean, timestamp, smallint, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Cascade-delete: a notification is personal to its user, so removing the
  // user removes their notifications (also lets a user be hard-deleted without
  // an FK RESTRICT). See migration 0038.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message'),
  severity: varchar('severity', { length: 20 }).default('info'),
  read: boolean('read').default(false),
  actionUrl: varchar('action_url', { length: 500 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),

  // SMS alert tracking — populated by alert-sms.service.ts. Null means the
  // row is still a candidate for an SMS to OPS_ALERT_PHONE; non-null means
  // we already sent (or successfully coalesced into a batch SMS).
  smsNotifiedAt: timestamp('sms_notified_at'),
  smsAttempts: smallint('sms_attempts').notNull().default(0),
}, (table) => [
  index('notifications_user_idx').on(table.userId),
]);
