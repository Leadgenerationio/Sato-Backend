import { pgTable, uuid, varchar, integer, decimal, date, timestamp, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { clients } from './clients.js';

export const leadDeliveries = pgTable('lead_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),
  deliveryDate: date('delivery_date').notNull(),
  leadCount: integer('lead_count').notNull().default(0),
  validLeadCount: integer('valid_lead_count'),
  invalidLeadCount: integer('invalid_lead_count'),
  revenue: decimal('revenue', { precision: 12, scale: 2 }),
  cost: decimal('cost', { precision: 12, scale: 2 }),
  leadbyteReportId: varchar('leadbyte_report_id', { length: 100 }),
  source: varchar('source', { length: 50 }).default('leadbyte'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('lead_deliveries_campaign_idx').on(table.campaignId),
  index('lead_deliveries_client_idx').on(table.clientId),
  index('lead_deliveries_date_idx').on(table.deliveryDate),
]);
