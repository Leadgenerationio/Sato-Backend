import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  type: varchar('type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message'),
  severity: varchar('severity', { length: 20 }).default('info'),
  read: boolean('read').default(false),
  actionUrl: varchar('action_url', { length: 500 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('notifications_user_idx').on(table.userId),
]);
