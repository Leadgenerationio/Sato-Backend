import { pgTable, uuid, varchar, decimal, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { campaigns } from './campaigns.js';

// Slice 2 Day 1: Sam Loom #40-46 — concept inversion. A campaign is a
// vertical (e.g. "Solar Panels"); many clients buy leads on it; deliveries
// reference both. This join table makes that many-to-many relationship
// explicit so the same campaign can serve multiple clients.
//
// The legacy `campaigns.client_id` column stays in place (nullable now) so
// old code keeps working. New rows in `client_campaigns` are the source of
// truth going forward; the migration backfills one row per legacy campaign.
export const clientCampaigns = pgTable('client_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }).notNull(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }).notNull(),
  // Per-client lead price — different buyers on the same vertical pay
  // different rates. Keeps the agreed price out of the campaign-level row.
  leadPrice: decimal('lead_price', { precision: 10, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('GBP'),
  status: varchar('status', { length: 20 }).default('active'),
  startedAt: timestamp('started_at').defaultNow(),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('client_campaigns_client_idx').on(table.clientId),
  index('client_campaigns_campaign_idx').on(table.campaignId),
  // One link per client+campaign pair — no duplicate rows for the same
  // buyer on the same vertical.
  uniqueIndex('client_campaigns_unique_idx').on(table.clientId, table.campaignId),
]);
