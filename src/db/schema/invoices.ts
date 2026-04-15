import { pgTable, uuid, varchar, integer, decimal, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),
  xeroInvoiceId: varchar('xero_invoice_id', { length: 100 }),
  invoiceNumber: varchar('invoice_number', { length: 50 }),
  status: varchar('status', { length: 50 }).default('draft'),
  currency: varchar('currency', { length: 3 }).default('GBP'),
  subtotal: decimal('subtotal', { precision: 12, scale: 2 }),
  vatAmount: decimal('vat_amount', { precision: 12, scale: 2 }),
  total: decimal('total', { precision: 12, scale: 2 }),
  dueDate: timestamp('due_date'),
  paidDate: timestamp('paid_date'),
  daysOverdue: integer('days_overdue').default(0),
  chaseCount: integer('chase_count').default(0),
  lastChasedAt: timestamp('last_chased_at'),
  lineItems: jsonb('line_items'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('invoices_client_idx').on(table.clientId),
  index('invoices_status_idx').on(table.status),
  index('invoices_due_idx').on(table.dueDate),
]);
