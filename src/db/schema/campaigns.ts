import { pgTable, uuid, varchar, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),
  leadbyteCampaignId: varchar('leadbyte_campaign_id', { length: 100 }),
  name: varchar('name', { length: 255 }).notNull(),
  vertical: varchar('vertical', { length: 100 }),
  status: varchar('status', { length: 50 }).default('active'),
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
]);
