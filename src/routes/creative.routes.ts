import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as creativeController from '../controllers/creative.controller.js';

export const creativeRoutes: RouterType = Router();

creativeRoutes.use(authMiddleware);
creativeRoutes.use(requireRole('owner', 'ops_manager'));

creativeRoutes.get('/campaigns/:campaignId/creatives', creativeController.listForCampaign);
creativeRoutes.post('/creatives', creativeController.create);
creativeRoutes.delete('/creatives/:id', creativeController.remove);
// Audit trail of every client approve/reject decision for legal-evidence use.
creativeRoutes.get('/creatives/:id/approval-history', creativeController.approvalHistory);
// T2: staff submit-for-approval gate. Drafts only — any other state 409s.
creativeRoutes.post('/creatives/:id/submit-for-approval', creativeController.submitForApproval);
