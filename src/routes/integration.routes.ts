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

// LeadByte
integrationRoutes.get('/leadbyte/status', integrationController.leadbyteStatus);
integrationRoutes.post('/leadbyte/sync', integrationController.leadbyteSyncNow);

// Credit check
integrationRoutes.get('/credit-check/status', integrationController.creditCheckStatus);

// Resend / DocuSign / R2 — read-only status indicators
integrationRoutes.get('/resend/status', integrationController.resendStatus);
integrationRoutes.get('/docusign/status', integrationController.docusignStatus);
integrationRoutes.get('/r2/status', integrationController.r2Status);
