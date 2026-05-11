import { pgTable, uuid, varchar, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

// Slice 2 Day 1 — concept inversion (Sam Loom #40).
// Before: a `campaigns` row represented one (client × vertical) pair, so
// "Solar Panels" would show up N times if N clients bought it. Sam wants
// "Solar Panels" as a single top-level vertical with the client buyers
// linked underneath via `client_campaigns`.
//
// Migration is non-destructive:
//   - `client_id` is now NULLABLE — new vertical-only campaign rows leave
//     it blank. The backfill populates the new `client_campaigns` join
//     table from existing client_id values so no link is lost.
//   - `cost_per_lead` is what Sam calls our cost (paid to the supplier);
//     `lead_price` stays as the price we charge the client. Per-client
//     pricing lives on `client_campaigns.lead_price`.
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Legacy single-client link — kept NULLABLE for back-compat. New rows that
  // represent a top-level vertical leave this blank; the buyer set lives in
  // `client_campaigns`.
  clientId: uuid('client_id').references(() => clients.id),
  leadbyteCampaignId: varchar('leadbyte_campaign_id', { length: 100 }),
  name: varchar('name', { length: 255 }).notNull(),
  vertical: varchar('vertical', { length: 100 }),
  // 'pay_per_lead' | 'managed' | 'internal' — matches Leadreports categorisation
  campaignType: varchar('campaign_type', { length: 30 }).default('pay_per_lead'),
  status: varchar('status', { length: 50 }).default('active'),
  // Our cost per lead (what we pay the supplier — Sam's #41 quick-win field).
  // Distinct from `lead_price` (what we charge the buyer) and from the
  // per-client agreed price on `client_campaigns.lead_price`.
  costPerLead: decimal('cost_per_lead', { precision: 10, scale: 2 }),
  leadPrice: decimal('lead_price', { precision: 10, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('GBP'),
  totalLeadsDelivered: integer('total_leads_delivered').default(0),
  totalRevenue: decimal('total_revenue', { precision: 12, scale: 2 }).default('0'),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('campaigns_client_idx').on(table.clientId),
  index('campaigns_vertical_idx').on(table.vertical),
]);
