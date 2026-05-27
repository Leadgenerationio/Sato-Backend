import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole, requireClientAdmin } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as portalController from '../controllers/portal.controller.js';

export const portalRoutes: RouterType = Router();

portalRoutes.use(authMiddleware);
// Sam (2026-05-27 portal meeting): client_admin is a sub-role of client
// with extra self-service permissions. Both roles share the read-side of
// the portal; client_admin-only routes layer requireClientAdmin() on top.
portalRoutes.use(requireRole('client', 'client_admin'));

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

// ─── Sam (2026-05-27 portal meeting) ─────────────────────────────────
// Client-side self-service: client_admin manages their own portal users +
// uploads an externally-signed agreement so they don't depend on Sam.
// Every route below is scoped to req.user.clientId server-side — a
// client_admin can ONLY act on users within their own client.
// ─────────────────────────────────────────────────────────────────────

portalRoutes.get('/users', portalController.listPortalUsers);

const createPortalUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    password: z.string().min(6).max(200),
    promoteAsClientAdmin: z.boolean().optional(),
  }),
});
portalRoutes.post(
  '/users',
  requireClientAdmin(),
  validate(createPortalUserSchema),
  portalController.createPortalUser,
);

const externalAgreementSchema = z.object({
  body: z.object({
    r2Key: z.string().min(1).max(500),
    fileName: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
});
portalRoutes.post(
  '/agreement/external',
  requireClientAdmin(),
  validate(externalAgreementSchema),
  portalController.uploadExternalAgreement,
);
