import { pgTable, uuid, varchar, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';

export const agreements = pgTable('agreements', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),

  // Legacy / generic
  documentUrl: varchar('document_url', { length: 500 }),
  signedByClient: boolean('signed_by_client').default(false),
  signedByBusiness: boolean('signed_by_business').default(false),
  signedAt: timestamp('signed_at'),
  status: varchar('status', { length: 50 }).default('pending'),

  // DocuSign integration
  docusignEnvelopeId: varchar('docusign_envelope_id', { length: 128 }),
  signerEmail: varchar('signer_email', { length: 255 }),
  signerName: varchar('signer_name', { length: 255 }),
  sentAt: timestamp('sent_at'),
  declinedAt: timestamp('declined_at'),
  declinedReason: varchar('declined_reason', { length: 500 }),

  // Storage — signed PDF in R2
  pdfR2Key: varchar('pdf_r2_key', { length: 500 }),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('agreements_client_idx').on(table.clientId),
  index('agreements_envelope_idx').on(table.docusignEnvelopeId),
]);
