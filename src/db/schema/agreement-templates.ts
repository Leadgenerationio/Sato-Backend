import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const agreementTemplates = pgTable('agreement_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: varchar('description', { length: 500 }),
  pdfR2Key: varchar('pdf_r2_key', { length: 500 }).notNull(),
  fieldLayout: jsonb('field_layout').notNull().default([]),
  signerRole: varchar('signer_role', { length: 100 }),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('agreement_templates_business_active_idx').on(table.businessId, table.createdAt),
]);

export interface FieldLayoutItem {
  id: string;
  type: 'variable' | 'signature' | 'date_signed' | 'text';
  variableKey?: string;
  text?: string;
  page: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  fontSize?: number;
}

export type FieldLayout = FieldLayoutItem[];
