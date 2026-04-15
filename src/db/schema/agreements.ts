import { pgTable, uuid, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

export const agreements = pgTable('agreements', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),
  documentUrl: varchar('document_url', { length: 500 }),
  signedByClient: boolean('signed_by_client').default(false),
  signedByBusiness: boolean('signed_by_business').default(false),
  signedAt: timestamp('signed_at'),
  status: varchar('status', { length: 50 }).default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
