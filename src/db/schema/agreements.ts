import { pgTable, uuid, varchar, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { agreementTemplates } from './agreement-templates.js';

// #47-50 PDF editor. A placed field on an outbound agreement PDF —
// the signer's screen shows a labelled box at this position and the
// configured type (signature, date_signed, text) dictates how SignNow
// renders the input.
//
// Coordinates are stored as fractions of the page (0.0–1.0) so re-renders
// at different DPIs / zoom levels translate cleanly. SignNow's API takes
// pixels at 72 DPI; the service layer converts on send.
export interface AgreementField {
  page: number;            // 1-indexed page number
  type: 'signature' | 'date_signed' | 'text';
  xPct: number;            // 0..1 left offset relative to page width
  yPct: number;            // 0..1 top offset relative to page height
  widthPct: number;
  heightPct: number;
  // For type='text' only — pre-filled value that signer can't edit.
  // For signature/date_signed this is ignored.
  prefillValue?: string;
}

export const agreements = pgTable('agreements', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id).notNull(),

  // Legacy / generic
  documentUrl: varchar('document_url', { length: 500 }),
  signedByClient: boolean('signed_by_client').default(false),
  signedByBusiness: boolean('signed_by_business').default(false),
  signedAt: timestamp('signed_at'),
  status: varchar('status', { length: 50 }).default('pending'),

  // E-signature provider (was DocuSign, now SignNow) — generic name so future
  // provider swaps don't require another migration.
  providerEnvelopeId: varchar('provider_envelope_id', { length: 128 }),
  signerEmail: varchar('signer_email', { length: 255 }),
  signerName: varchar('signer_name', { length: 255 }),
  // Sam Loom #68 — editable signatory role/title (e.g. "Director", "CEO",
  // "Compliance Officer") so the legal title under the signature line is
  // accurate and the audit trail captures who signed in what capacity.
  // Nullable for back-compat — agreements created before this column lands
  // simply have no role recorded.
  signerRole: varchar('signer_role', { length: 100 }),
  sentAt: timestamp('sent_at'),
  declinedAt: timestamp('declined_at'),
  declinedReason: varchar('declined_reason', { length: 500 }),

  // Storage — signed PDF in R2
  pdfR2Key: varchar('pdf_r2_key', { length: 500 }),

  // #47-50 PDF editor — drag-placed fields (signature, date, text) from the
  // editor UI. NULL = free-form invite (signer places wherever, legacy flow).
  // Non-null = role-based invite with pre-placed fields. Both flows are
  // supported on the same endpoint for backward compat.
  fields: jsonb('fields').$type<AgreementField[]>(),

  // PDF template auto-populate (P12)
  templateId: uuid('template_id').references(() => agreementTemplates.id),
  populatedPdfR2Key: varchar('populated_pdf_r2_key', { length: 500 }),
  overrides: jsonb('overrides').notNull().default({}),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('agreements_client_idx').on(table.clientId),
  index('agreements_envelope_idx').on(table.providerEnvelopeId),
]);
