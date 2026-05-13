import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { clients } from './clients.js';

// L #38 (Sam Loom — full activity feed). Per-client append-only event
// stream. Same shape as task_activity_log but scoped to a client. Read
// by the client detail "Activity" tab to render one timeline.
//
// Why a single feed table vs. union queries across documents/contacts/
// agreements/etc: union queries grow brittle (every new module adds a
// case statement, easy to forget) and the schemas don't align. A
// dedicated log lets each module emit one well-shaped event and the
// reader stays simple.
export const clientActivityLog = pgTable('client_activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Examples: client_created, client_updated, contact_added, contact_removed,
  // document_uploaded, document_removed, agreement_status_changed,
  // credit_check_run, email_logged_inbound, email_logged_outbound,
  // invoice_synced, status_changed.
  eventType: varchar('event_type', { length: 60 }).notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('client_activity_client_idx').on(table.clientId, table.createdAt),
  index('client_activity_event_idx').on(table.eventType),
]);
