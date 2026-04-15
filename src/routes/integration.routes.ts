import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as integrationController from '../controllers/integration.controller.js';

export const integrationRoutes: RouterType = Router();

integrationRoutes.use(authMiddleware);
integrationRoutes.use(requireRole('owner'));

// Xero OAuth
integrationRoutes.get('/xero/auth-url', integrationController.xeroAuthUrl);
integrationRoutes.get('/xero/callback', integrationController.xeroCallback);
integrationRoutes.get('/xero/status', integrationController.xeroStatus);
integrationRoutes.post('/xero/disconnect', integrationController.xeroDisconnect);
