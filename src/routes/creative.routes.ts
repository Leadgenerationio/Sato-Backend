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
// Per-resource signed-url. Replaces the FE-side fetchFreshDownloadUrl(folder,
// key) which baked in the wrong folder per page (portal:'creatives' vs
// agency:'misc'). The server now resolves the folder from the stored
// file_url. Also gates by business membership (closes the over-broad
// /uploads/signed-url authz for creatives).
creativeRoutes.get('/creatives/:id/signed-url', creativeController.signedUrl);
// Audit trail of every client approve/reject decision for legal-evidence use.
creativeRoutes.get('/creatives/:id/approval-history', creativeController.approvalHistory);
// T2: staff submit-for-approval gate. Drafts only — any other state 409s.
creativeRoutes.post('/creatives/:id/submit-for-approval', creativeController.submitForApproval);
