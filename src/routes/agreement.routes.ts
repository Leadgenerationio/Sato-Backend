import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as agreementController from '../controllers/agreement.controller.js';

export const agreementRoutes = Router();

// Admin — send agreement + list/get
agreementRoutes.post(
  '/agreements',
  authMiddleware,
  requireRole('owner', 'ops_manager'),
  agreementController.send,
);

agreementRoutes.get(
  '/clients/:clientId/agreements',
  authMiddleware,
  agreementController.listForClient,
);

agreementRoutes.get(
  '/agreements',
  authMiddleware,
  requireRole('owner', 'ops_manager', 'finance_admin'),
  agreementController.listAll,
);

agreementRoutes.get(
  '/agreements/:id',
  authMiddleware,
  agreementController.getOne,
);

agreementRoutes.post(
  '/agreements/:id/refresh-status',
  authMiddleware,
  requireRole('owner', 'ops_manager'),
  agreementController.refreshStatus,
);

// DocuSign webhook — unauthenticated, must be reachable by DocuSign Connect.
// In production, verify the HMAC signature in the controller.
agreementRoutes.post(
  '/webhooks/docusign',
  agreementController.docusignWebhook,
);
