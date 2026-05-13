import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as autoInvoiceController from '../controllers/auto-invoice.controller.js';

export const autoInvoiceRoutes: RouterType = Router();

autoInvoiceRoutes.use(authMiddleware);
autoInvoiceRoutes.use(requireRole('owner', 'finance_admin'));

autoInvoiceRoutes.get('/runs', autoInvoiceController.listRuns);
autoInvoiceRoutes.get('/runs/next', autoInvoiceController.nextWindow);
autoInvoiceRoutes.get('/runs/:id', autoInvoiceController.getRun);
autoInvoiceRoutes.post('/runs', autoInvoiceController.runNow);
