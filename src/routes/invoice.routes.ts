import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as invoiceController from '../controllers/invoice.controller.js';

export const invoiceRoutes: RouterType = Router();

invoiceRoutes.use(authMiddleware);
invoiceRoutes.use(requireRole('owner', 'finance_admin'));

invoiceRoutes.get('/', invoiceController.listInvoices);
invoiceRoutes.get('/overdue', invoiceController.getOverdue);
invoiceRoutes.get('/clients', invoiceController.getClients);
invoiceRoutes.get('/:id', invoiceController.getInvoice);
invoiceRoutes.post('/', invoiceController.createInvoice);
invoiceRoutes.post('/:id/push-to-xero', invoiceController.pushToXero);
invoiceRoutes.post('/:id/attachments', invoiceController.addAttachment);
invoiceRoutes.delete('/:id/attachments/:key', invoiceController.removeAttachment);
