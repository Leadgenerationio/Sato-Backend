import { pgTable, uuid, varchar, text, integer, boolean, decimal, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { businesses } from './businesses.js';

export const clientStatusEnum = pgEnum('client_status', [
  'prospect', 'onboarding', 'active', 'paused', 'churned',
]);

export const onboardingStatusEnum = pgEnum('onboarding_status', [
  'pending', 'documents_received', 'agreement_signed', 'active',
]);

export const billingWorkflowEnum = pgEnum('billing_workflow', [
  'weekly_auto', 'monthly_validated', 'custom',
]);

// `managed` = bundled monthly retainer (no per-lead pricing, no ad-spend visible).
// `ppl` = pay-per-lead (default). Drives portal widget/tab visibility.
export const clientTypeEnum = pgEnum('client_type', ['managed', 'ppl']);

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  companyNumber: varchar('company_number', { length: 20 }),
  contactName: varchar('contact_name', { length: 255 }),
  contactEmail: varchar('contact_email', { length: 255 }),
  contactPhone: varchar('contact_phone', { length: 50 }),
  address: text('address'),
  currency: varchar('currency', { length: 3 }).default('GBP'),
  paymentTermsDays: integer('payment_terms_days').default(30),
  vatRegistered: boolean('vat_registered').default(false),
  addVatToInvoices: boolean('add_vat_to_invoices').default(false),
  creditScore: integer('credit_score'),
  creditLastChecked: timestamp('credit_last_checked'),
  status: clientStatusEnum('status').default('prospect'),
  onboardingStatus: onboardingStatusEnum('onboarding_status').default('pending'),
  clientType: clientTypeEnum('client_type').default('ppl').notNull(),
  billingWorkflow: billingWorkflowEnum('billing_workflow').default('weekly_auto'),
  leadPrice: decimal('lead_price', { precision: 10, scale: 2 }),
  leadPriceCurrency: varchar('lead_price_currency', { length: 3 }).default('GBP'),
  agreementSigned: boolean('agreement_signed').default(false),
  agreementDocumentUrl: varchar('agreement_document_url', { length: 500 }),
  xeroContactId: varchar('xero_contact_id', { length: 100 }),
  leadbyteClientId: varchar('leadbyte_client_id', { length: 100 }),
  endoleCompanyId: varchar('endole_company_id', { length: 100 }),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  index('clients_business_idx').on(table.businessId),
  index('clients_status_idx').on(table.status),
]);
