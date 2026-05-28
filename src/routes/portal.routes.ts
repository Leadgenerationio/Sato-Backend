import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as portalController from '../controllers/portal.controller.js';

export const portalRoutes: RouterType = Router();

portalRoutes.use(authMiddleware);
// Sam (2026-05-27 jam-video #2): the portal is *display-only*. We add
// portal users + upload signed agreements ourselves on the admin side;
// the portal user account just sees their own org's data. Both 'client'
// and 'client_admin' share the same read-only surface — the client_admin
// distinction is kept as a column so admin-side tooling can later mark
// a primary contact, but the portal grants no extra abilities to it.
portalRoutes.use(requireRole('client', 'client_admin'));

portalRoutes.get('/dashboard', portalController.dashboard);
portalRoutes.get('/campaigns', portalController.campaigns);
portalRoutes.get('/leads', portalController.leads);
portalRoutes.get('/invoices', portalController.invoices);
portalRoutes.get('/compliance', portalController.compliance);
portalRoutes.get('/agreement', portalController.agreement);

// Creative review v2 (Sam #9/#11 — 2026-05-17). Buyer-facing review tab
// at /portal/compliance does approve/reject; /portal/creatives is a
// read-only display of what's already approved (Sam jam-video #2).
portalRoutes.get('/creatives', portalController.creatives);
portalRoutes.post('/creatives/:creativeId/approve', portalController.approveCreative);
portalRoutes.post('/creatives/:creativeId/reject', portalController.rejectCreative);
portalRoutes.post('/creatives/:creativeId/request-changes', portalController.requestChangesCreative);
