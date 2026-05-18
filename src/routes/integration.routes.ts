import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as integrationController from '../controllers/integration.controller.js';

export const integrationRoutes: RouterType = Router();

integrationRoutes.use(authMiddleware);
integrationRoutes.use(requireRole('owner'));

// Aggregate overview — one round-trip for the visual /integrations dashboard.
integrationRoutes.get('/overview', integrationController.overview);

// Xero — Custom Connection (server-to-server). No OAuth consent flow needed.
integrationRoutes.get('/xero/status', integrationController.xeroStatus);
integrationRoutes.post('/xero/disconnect', integrationController.xeroDisconnect);
integrationRoutes.get('/xero/bank-accounts', integrationController.xeroBankAccounts);
integrationRoutes.get('/xero/vat-liability', integrationController.xeroVatLiability);
// Diagnostic for the client-create auto-bind. Pass ?clientId=<uuid> to
// inspect a specific client's lookup, or ?name=...&companyNumber=... for
// an ad-hoc probe.
integrationRoutes.get('/xero/diagnose-contact', integrationController.xeroDiagnoseContact);

// LeadByte
integrationRoutes.get('/leadbyte/status', integrationController.leadbyteStatus);
integrationRoutes.post('/leadbyte/sync', integrationController.leadbyteSyncNow);

// Credit check
integrationRoutes.get('/credit-check/status', integrationController.creditCheckStatus);

// Resend / SignNow / R2 / Catchr — read-only status indicators
integrationRoutes.get('/resend/status', integrationController.resendStatus);
integrationRoutes.get('/signnow/status', integrationController.signnowStatus);
integrationRoutes.get('/r2/status', integrationController.r2Status);
integrationRoutes.get('/catchr/status', integrationController.catchrStatus);
// Platform + account pickers for the campaign Traffic Sources UI — the
// supplier dropdown reads /catchr/platforms; selecting one drives a
// /catchr/accounts fetch. Both replace the old free-form text paste.
integrationRoutes.get('/catchr/platforms', integrationController.catchrPlatforms);
integrationRoutes.get('/catchr/accounts', integrationController.catchrAccounts);
