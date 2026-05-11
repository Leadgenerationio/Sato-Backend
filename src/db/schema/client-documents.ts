import { pgTable, uuid, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { users } from './users.js';

// Sam's Loom #36: due-diligence forms, signed agreements, compliance docs etc.
// belong on the client record itself, not in browser localStorage. Files live
// in R2; this table tracks the metadata + ownership so docs survive across
// browsers and survive the staff member who uploaded them leaving.
export const clientDocuments = pgTable('client_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }).notNull(),
  // R2 object key + folder — same shape returned by the /uploads/presign route.
  r2Key: varchar('r2_key', { length: 500 }).notNull(),
  folder: varchar('folder', { length: 50 }).notNull().default('misc'),
  name: varchar('name', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 100 }),
  sizeBytes: integer('size_bytes'),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('client_documents_client_idx').on(table.clientId),
]);
