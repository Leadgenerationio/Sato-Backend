import { pgTable, uuid, varchar, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { invoices } from './invoices.js';

export const chaseHistory = pgTable('chase_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  chaseNumber: integer('chase_number').notNull(),
  sentAt: timestamp('sent_at').defaultNow(),
  method: varchar('method', { length: 50 }).notNull(),
  response: text('response'),
  nextChaseAt: timestamp('next_chase_at'),
});
