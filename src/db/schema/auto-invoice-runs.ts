import { pgTable, uuid, varchar, integer, decimal, date, timestamp, jsonb, text, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';
import { users } from './users.js';

export type AutoInvoiceClientDetailStatus =
  | 'invoiced'        // invoice successfully created (and pushed to Xero if configured)
  | 'no_deliveries'   // client had zero deliveries in the week — nothing to bill
  | 'no_lead_price'   // client has deliveries but no lead_price configured
  | 'failed';         // invoice creation threw; reason captured

export interface AutoInvoiceClientDetail {
  clientId: string;
  clientName: string;
  leads: number;
  amount: string;             // decimal-on-the-wire
  currency: string;
  invoiceId?: string;
  invoiceNumber?: string;
  status: AutoInvoiceClientDetailStatus;
  reason?: string;
}

export const autoInvoiceRuns = pgTable('auto_invoice_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id),
  periodFrom: date('period_from').notNull(),
  periodTo: date('period_to').notNull(),
  triggeredBy: varchar('triggered_by', { length: 20 }).notNull().default('scheduled'),
  triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  clientsBilled: integer('clients_billed').notNull().default(0),
  clientsSkipped: integer('clients_skipped').notNull().default(0),
  clientsFailed: integer('clients_failed').notNull().default(0),
  invoicesCreated: integer('invoices_created').notNull().default(0),
  totalAmount: decimal('total_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  details: jsonb('details').$type<AutoInvoiceClientDetail[]>().notNull().default(sql`'[]'::jsonb`),
  error: text('error'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('auto_invoice_runs_business_idx').on(table.businessId),
  index('auto_invoice_runs_started_idx').on(table.startedAt),
]);
