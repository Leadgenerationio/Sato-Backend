import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Slice 5 Day 6 (Sam Loom #100) — SOS help button.
// The button opens the user's WhatsApp pre-filled with a message to Sam.
// We also record the request server-side so Sam can see who's stuck and
// follow up later — independent of whether the user actually sent the WA
// message after the deep-link opened.
export const sosHelpRequests = pgTable('sos_help_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  // Page the user pressed SOS from — gives Sam context without the user
  // having to type it. Free text since FE paths change.
  pagePath: varchar('page_path', { length: 500 }),
  // The free-form context the user typed into the dialog. Optional —
  // a "tap and panic" SOS is still useful.
  message: text('message'),
  // Resolved by Sam (or another owner) once they've followed up.
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('sos_help_user_idx').on(table.userId),
  index('sos_help_created_idx').on(table.createdAt),
]);
