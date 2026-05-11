import { pgTable, uuid, varchar, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

// Sam's Loom #17-18: a client can have several real-world contacts. The three
// types he named ("primary", "billing", "compliance") are first-class; "other"
// catches things like a National Sales Director who isn't any of those.
export const contactTypeEnum = pgEnum('client_contact_type', [
  'primary', 'billing', 'compliance', 'other',
]);

export const clientContacts = pgTable('client_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }).notNull(),
  contactType: contactTypeEnum('contact_type').notNull().default('other'),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  // Free-text job title — Sam called out "Jamie Roberts, National Sales Director".
  role: varchar('role', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('client_contacts_client_idx').on(table.clientId),
  index('client_contacts_type_idx').on(table.clientId, table.contactType),
]);
