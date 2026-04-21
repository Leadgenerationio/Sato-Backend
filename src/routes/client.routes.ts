import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as clientController from '../controllers/client.controller.js';

export const clientRoutes: RouterType = Router();

clientRoutes.use(authMiddleware);
clientRoutes.use(requireRole('owner', 'finance_admin', 'ops_manager'));

clientRoutes.get('/', clientController.listClients);
clientRoutes.get('/credit-alerts', clientController.getCreditAlerts);
clientRoutes.get('/:id', clientController.getClient);
clientRoutes.post('/', clientController.createClient);
clientRoutes.put('/:id', clientController.updateClient);
clientRoutes.get('/:id/credit-history', clientController.getCreditHistory);
clientRoutes.post('/:id/credit-check', clientController.runCreditCheck);
