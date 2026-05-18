import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as portalController from '../controllers/portal.controller.js';

export const portalRoutes: RouterType = Router();

portalRoutes.use(authMiddleware);
portalRoutes.use(requireRole('client'));

portalRoutes.get('/dashboard', portalController.dashboard);
portalRoutes.get('/campaigns', portalController.campaigns);
portalRoutes.get('/leads', portalController.leads);
portalRoutes.get('/invoices', portalController.invoices);
portalRoutes.get('/compliance', portalController.compliance);
portalRoutes.get('/agreement', portalController.agreement);

// Creative review v2 (Sam #9/#11 — 2026-05-17). Buyer-facing review tab
// at /portal/creatives. Returns assets split into 2 sections (media vs
// copy_lp). Append-only audit log; each decision is a new row.
portalRoutes.get('/creatives', portalController.creatives);
portalRoutes.post('/creatives/:creativeId/approve', portalController.approveCreative);
portalRoutes.post('/creatives/:creativeId/reject', portalController.rejectCreative);
portalRoutes.post('/creatives/:creativeId/request-changes', portalController.requestChangesCreative);
