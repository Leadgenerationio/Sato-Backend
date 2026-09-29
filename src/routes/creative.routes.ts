import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as creativeController from '../controllers/creative.controller.js';

export const creativeRoutes: RouterType = Router();

// This router is mounted at '/' (routes/index.ts), so a router-level
// .use(requireRole(...)) ran for EVERY request that reached it — including
// /dashboard, /finance/bank-feed, /finance/auto-invoice and
// /agreement-templates, which are mounted after it. That 403'd Finance Admin
// and Readonly on sections their own routes allow (found while wiring the
// Role Access Matrix, S7). The guard is now per-route, so it only applies to
// the creative endpoints below.
const staff = [authMiddleware, requireRole('owner', 'ops_manager')];

creativeRoutes.get('/campaigns/:campaignId/creatives', ...staff, creativeController.listForCampaign);
creativeRoutes.post('/creatives', ...staff, creativeController.create);
creativeRoutes.delete('/creatives/:id', ...staff, creativeController.remove);
// Per-resource signed-url. Replaces the FE-side fetchFreshDownloadUrl(folder,
// key) which baked in the wrong folder per page (portal:'creatives' vs
// agency:'misc'). The server now resolves the folder from the stored
// file_url. Also gates by business membership (closes the over-broad
// /uploads/signed-url authz for creatives).
creativeRoutes.get('/creatives/:id/signed-url', ...staff, creativeController.signedUrl);
// Audit trail of every client approve/reject decision for legal-evidence use.
creativeRoutes.get('/creatives/:id/approval-history', ...staff, creativeController.approvalHistory);
// T2: staff submit-for-approval gate. Drafts only — any other state 409s.
creativeRoutes.post('/creatives/:id/submit-for-approval', ...staff, creativeController.submitForApproval);
