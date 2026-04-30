import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationQuerySchema } from '../types/index.js';
import * as clientController from '../controllers/client.controller.js';

export const clientRoutes: RouterType = Router();

const listClientsQuerySchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.string().optional(),
    search: z.string().optional(),
  }),
});

const clientStatusEnum = z.enum(['prospect', 'active', 'paused', 'churned']);
const onboardingEnum = z.enum(['pending', 'agreement_sent', 'agreement_signed', 'onboarded']);
const billingWorkflowEnum = z.enum(['weekly_auto', 'monthly_auto', 'manual']);

const clientCoreFields = {
  companyName: z.string().min(1).max(200),
  companyNumber: z.string().min(1).max(50).optional(),
  contactName: z.string().min(1).max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  currency: z.string().length(3).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  vatRegistered: z.boolean().optional(),
  addVatToInvoices: z.boolean().optional(),
  leadPrice: z.union([z.number(), z.string()]).optional(),
  billingWorkflow: billingWorkflowEnum.optional(),
  onboardingStatus: onboardingEnum.optional(),
  status: clientStatusEnum.optional(),
  notes: z.string().max(5000).optional(),
  leadbyteClientId: z.string().max(100).optional(),
  endoleCompanyId: z.string().max(100).optional(),
  xeroContactId: z.string().max(100).optional(),
};

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
clientRoutes.get('/:id', clientController.getClient);
clientRoutes.post('/', validate(createClientSchema), clientController.createClient);
clientRoutes.put('/:id', validate(updateClientSchema), clientController.updateClient);
clientRoutes.get('/:id/credit-history', clientController.getCreditHistory);
clientRoutes.post('/:id/credit-check', clientController.runCreditCheck);
