import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationQuerySchema } from '../types/index.js';
import * as clientController from '../controllers/client.controller.js';
import * as clientDocumentsController from '../controllers/client-documents.controller.js';
import * as clientInvoicesController from '../controllers/client-invoices.controller.js';
import * as clientCampaignsController from '../controllers/client-campaigns.controller.js';
import * as clientActivityController from '../controllers/client-activity.controller.js';
import * as clientEmailsController from '../controllers/client-emails.controller.js';
import * as clientImportController from '../controllers/client-import.controller.js';

export const clientRoutes: RouterType = Router();

const listClientsQuerySchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.string().optional(),
    search: z.string().optional(),
  }),
});

// Mirror the DB pgEnums verbatim. Earlier this file diverged — billingWorkflow
// was `['weekly_auto', 'monthly_auto', 'manual']` while the DB defined
// `['weekly_auto', 'monthly_validated', 'custom']`. That mismatch was the
// "Validation failed, billing workflow invalid" Sam hit in his Loom (#21):
// the frontend was sending the correct DB values which zod then rejected.
// Sam Loom #31 (13 May response) — only 3 statuses supported going forward.
// The DB enum still has 'prospect' + 'paused' for back-compat, but the
// API refuses to accept them (existing rows migrated via 0022). UI labels
// live on the FE: 'onboarding' → "Onboarding", 'active' → "Active Client",
// 'churned' → "Client Churned".
const clientStatusEnum = z.enum(['onboarding', 'active', 'churned']);
const onboardingEnum = z.enum(['pending', 'documents_received', 'agreement_signed', 'active']);
const billingWorkflowEnum = z.enum(['weekly_auto', 'monthly_validated', 'custom']);
const contactTypeEnum = z.enum(['primary', 'billing', 'compliance', 'other']);

const contactSchema = z.object({
  contactType: contactTypeEnum.optional(),
  name: z.string().min(1).max(255),
  email: z.string().email().or(z.literal('')).optional(),
  phone: z.string().max(50).optional(),
  role: z.string().max(100).optional(),
});

const clientCoreFields = {
  companyName: z.string().min(1).max(200),
  companyNumber: z.string().min(1).max(50).optional(),
  contactName: z.string().min(1).max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  addressLine: z.string().max(255).optional(),
  addressTown: z.string().max(100).optional(),
  addressCounty: z.string().max(100).optional(),
  addressCountry: z.string().max(100).optional(),
  addressPostcode: z.string().max(20).optional(),
  currency: z.string().length(3).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  vatRegistered: z.boolean().optional(),
  addVatToInvoices: z.boolean().optional(),
  vatNumber: z.string().max(50).optional(),
  vatRate: z.union([z.number(), z.string()]).optional(),
  leadPrice: z.union([z.number(), z.string()]).optional(),
  // Fix 6a (2026-06-15): managed vs pay-per-lead. Gates portal ad-spend
  // visibility (PPL clients must never see spend).
  clientType: z.enum(['managed', 'ppl']).optional(),
  billingWorkflow: billingWorkflowEnum.optional(),
  onboardingStatus: onboardingEnum.optional(),
  status: clientStatusEnum.optional(),
  notes: z.string().max(5000).optional(),
  leadbyteClientId: z.string().max(100).optional(),
  endoleCompanyId: z.string().max(100).optional(),
  xeroContactId: z.string().max(100).optional(),
  // Sam (27 May 2026 portal meeting): Benson signed outside the platform
  // so the dashboard's "Pending agreement, action needed" banner reads
  // wrong. Need an admin-side override that flips agreementSigned=true
  // without going through SignNow. Update endpoint accepts it directly;
  // FE surfaces a "Mark agreement as signed" button on client detail.
  agreementSigned: z.boolean().optional(),
  contacts: z.array(contactSchema).optional(),
};

const addDocumentSchema = z.object({
  body: z.object({
    r2Key: z.string().min(1).max(500),
    folder: z.string().max(50).optional(),
    name: z.string().min(1).max(255),
    contentType: z.string().max(100).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
});

const createClientSchema = z.object({
  body: z.object(clientCoreFields),
});

const updateClientSchema = z.object({
  body: z.object(clientCoreFields).partial(),
});

clientRoutes.use(authMiddleware);
clientRoutes.use(requireRole('owner', 'finance_admin', 'ops_manager'));

clientRoutes.get('/', validate(listClientsQuerySchema), clientController.listClients);
clientRoutes.get('/credit-alerts', clientController.getCreditAlerts);

// #39 Attio bulk import. Static paths must be registered BEFORE /:id
// catch-alls so Express doesn't route "import" to getClient.
const importAttioSchema = z.object({
  body: z.object({
    attioIds: z.array(z.string().min(1).max(100)).min(1).max(200),
  }),
});
clientRoutes.get('/import/attio/companies', clientImportController.browseAttio);
clientRoutes.post('/import/attio', validate(importAttioSchema), clientImportController.importFromAttio);
clientRoutes.get('/:id', clientController.getClient);
clientRoutes.post('/', validate(createClientSchema), clientController.createClient);
clientRoutes.put('/:id', validate(updateClientSchema), clientController.updateClient);
clientRoutes.get('/:id/credit-history', clientController.getCreditHistory);
clientRoutes.post('/:id/credit-check', clientController.runCreditCheck);

// Slice 1 Day 3: client documents — replaces localStorage on the frontend
// Documents tab. Files live in R2 (uploaded via /api/v1/uploads/presign);
// these routes track the metadata + ownership.
clientRoutes.get('/:id/documents', clientDocumentsController.list);
clientRoutes.post('/:id/documents', validate(addDocumentSchema), clientDocumentsController.add);
clientRoutes.delete('/:id/documents/:docId', clientDocumentsController.remove);

// Slice 1 Day 4: per-client invoices — Sam's Loom #30 ("I don't get why
// there is no invoices for this client"). Returns Stato-DB invoices scoped
// to this client. Xero-side invoices not yet in our DB are out of scope —
// a future "sync invoices from Xero" job will populate them.
clientRoutes.get('/:id/invoices', clientInvoicesController.listForClient);
clientRoutes.post('/:id/sync-invoices', clientInvoicesController.syncForClient);

// Slice 2 Day 1: reverse lookup — which campaigns is this client buying?
clientRoutes.get('/:id/campaigns', clientCampaignsController.listForClient);

// L #38 — full activity feed (every event tied to this client).
clientRoutes.get('/:id/activity', clientActivityController.listActivity);

// L #33 — email thread (inbound + outbound). POST for manual log of
// inbound; outbound rows are auto-logged from the Resend send path.
const logEmailSchema = z.object({
  body: z.object({
    direction: z.enum(['inbound', 'outbound']),
    subject: z.string().max(500).optional(),
    body: z.string().max(50000).optional(),
    fromAddress: z.string().max(255).optional(),
    toAddress: z.string().max(255).optional(),
    occurredAt: z.string().datetime().optional(),
  }),
});
clientRoutes.get('/:id/emails', clientEmailsController.listEmails);
clientRoutes.post('/:id/emails', validate(logEmailSchema), clientEmailsController.logEmail);
clientRoutes.delete('/:id/emails/:emailId', clientEmailsController.deleteEmail);
