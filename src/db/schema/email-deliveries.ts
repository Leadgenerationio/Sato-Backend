import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Sam (2026-08-20, Barry @ media-active.org.uk): the welcome email was
// ACCEPTED by Resend (200 + message id) but never reached the inbox. Without
// a delivery ledger the Portal Users card reported "sent" either way, so a
// quarantined invite was indistinguishable from a delivered one.
//
// One row per outbound Resend message. `sendEmail()` inserts on a successful
// send; the Resend webhook updates the row in place as events arrive.
export const emailDeliveries = pgTable('email_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Resend message id — unique, so replayed webhooks are idempotent.
  messageId: varchar('message_id', { length: 255 }).notNull(),
  toAddress: varchar('to_address', { length: 255 }).notNull(),
  fromAddress: varchar('from_address', { length: 255 }),
  subject: varchar('subject', { length: 500 }),
  // 'portal_welcome' | 'password_reset' | 'notification' | ...
  kind: varchar('kind', { length: 50 }),
  // Highest-ranked state seen so far; never moves backwards.
  status: varchar('status', { length: 30 }).notNull().default('sent'),
  lastEvent: varchar('last_event', { length: 50 }),
  // Why it failed — bounce classification + provider message.
  failureType: varchar('failure_type', { length: 50 }),
  failureReason: text('failure_reason'),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
  lastEventAt: timestamp('last_event_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  uniqueIndex('email_deliveries_message_id_idx').on(table.messageId),
  index('email_deliveries_to_address_idx').on(table.toAddress, table.sentAt),
  index('email_deliveries_status_idx').on(table.status),
]);
