import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationQuerySchema } from '../types/index.js';
import * as invoiceController from '../controllers/invoice.controller.js';

export const invoiceRoutes: RouterType = Router();

const listInvoicesQuerySchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.string().optional(),
    client: z.string().optional(),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'dueDate', 'total', 'status', 'invoiceNumber']).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  }),
});

invoiceRoutes.use(authMiddleware);
invoiceRoutes.use(requireRole('owner', 'finance_admin'));

invoiceRoutes.get('/', validate(listInvoicesQuerySchema), invoiceController.listInvoices);
invoiceRoutes.get('/overdue', invoiceController.getOverdue);
invoiceRoutes.get('/outstanding', invoiceController.getOutstanding);
invoiceRoutes.get('/clients', invoiceController.getClients);
invoiceRoutes.get('/:id', invoiceController.getInvoice);
invoiceRoutes.post('/', validate(invoiceController.createInvoiceSchema), invoiceController.createInvoice);
invoiceRoutes.post('/:id/push-to-xero', invoiceController.pushToXero);
invoiceRoutes.post('/:id/attachments', invoiceController.addAttachment);
invoiceRoutes.delete('/:id/attachments/:key', invoiceController.removeAttachment);
