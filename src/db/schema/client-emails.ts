import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { clients } from './clients.js';

// L #33 (Sam Loom — full email-thread integration). Stores emails
// associated with a client in either direction. Phase 1 sources:
//   - outbound: auto-logged when Resend sends an email for this client
//     (invoice send, agreement send, credit alert).
//   - inbound: manually logged by an internal user via the UI (no
//     IMAP/Gmail integration yet — that's a separate, future build).
//
// `messageId` and `resendEvent` are populated only for outbound rows.
// The thread view sorts by `occurredAt` so logged-after-the-fact
// inbound emails can be back-dated without breaking ordering.
export const clientEmails = pgTable('client_emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  direction: varchar('direction', { length: 10 }).notNull(), // 'inbound' | 'outbound'
  subject: varchar('subject', { length: 500 }),
  body: text('body'),
  fromAddress: varchar('from_address', { length: 255 }),
  toAddress: varchar('to_address', { length: 255 }),
  // Resend message-id (outbound only) — handy for cross-referencing if
  // we ever wire delivery/open events back in.
  messageId: varchar('message_id', { length: 255 }),
  resendEvent: varchar('resend_event', { length: 50 }), // delivered | opened | clicked | bounced
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  loggedBy: uuid('logged_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('client_emails_client_idx').on(table.clientId, table.occurredAt),
  index('client_emails_direction_idx').on(table.direction),
]);
