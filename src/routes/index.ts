import { Router, type Router as RouterType } from 'express';
import { authRoutes } from './auth.routes.js';
import { userRoutes } from './user.routes.js';
import { permissionRoutes } from './permission.routes.js';
import { integrationRoutes } from './integration.routes.js';
import { campaignRoutes } from './campaign.routes.js';
import { invoiceRoutes } from './invoice.routes.js';
import { clientRoutes } from './client.routes.js';
import { portalRoutes } from './portal.routes.js';
import { workflowRoutes } from './workflow.routes.js';
import { reportRoutes } from './report.routes.js';
import { notificationRoutes } from './notification.routes.js';
import { taskRoutes } from './task.routes.js';
import { staffRoutes } from './staff.routes.js';
import { sopRoutes } from './sop.routes.js';
import { agreementRoutes } from './agreement.routes.js';
import { leadbyteRoutes } from './leadbyte.routes.js';
import { adSpendRoutes } from './ad-spend.routes.js';
import { adAccountRoutes, clientLookupRoutes } from './ad-account.routes.js';
import { uploadRoutes } from './upload.routes.js';
import { creativeRoutes } from './creative.routes.js';
import { creativeLibraryRoutes } from './creative-library.routes.js';
import { bankFeedRoutes } from './bank-feed.routes.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { sosHelpRoutes } from './sos-help.routes.js';
import { autoInvoiceRoutes } from './auto-invoice.routes.js';
import { healthRoutes } from './health.routes.js';
import { agreementTemplateRoutes } from './agreement-template.routes.js';
import { webhookRoutes } from './webhook.routes.js';
import { adminCleanupRoutes } from './admin-cleanup.routes.js';
import { webhookEndpointRoutes } from './webhook-endpoint.routes.js';
import { apiKeyRoutes } from './api-key.routes.js';
import { buildOpenApi, docsHtml } from '../docs/openapi.js';
import { requireSection } from '../middleware/section.middleware.js';
import { SECTIONS } from '../config/sections.js';
export const router: RouterType = Router();

// Public — must be before any auth middleware on individual routers.
router.use('/health', healthRoutes);
// Provider webhooks — unauthenticated, signature-verified in the controllers.
router.use('/webhooks', webhookRoutes);

// Public API docs (plan phase 2) — no auth.
router.get('/openapi.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(buildOpenApi(`${req.protocol}://${req.get('host')}/api/v1`));
});
router.get('/docs', (_req, res) => {
  // helmet's default CSP blocks the CDN script the reference page needs.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:; img-src 'self' data: https:; connect-src 'self'");
  res.type('html').send(docsHtml('/api/v1/openapi.json'));
});

router.use('/auth', authRoutes);

// Role Access Matrix (S7): an Owner can switch a section off for a role in
// Settings → User Management, and that is enforced here, in front of every
// router below. It only restricts — each router's requireRole() stays the
// real gate. See src/config/sections.ts for the prefix → section map.
for (const section of SECTIONS) {
  for (const prefix of section.apiPrefixes) router.use(prefix, requireSection(section.key));
}

router.use('/users', userRoutes);
router.use('/admin/cleanup', adminCleanupRoutes);
router.use('/permissions', permissionRoutes);
router.use('/integrations', integrationRoutes);
router.use('/campaigns', campaignRoutes);
router.use('/invoices', invoiceRoutes);
// Before clientRoutes: its GET /:id would otherwise swallow /clients/lookup.
router.use('/clients', clientLookupRoutes);
router.use('/clients', clientRoutes);
router.use('/portal', portalRoutes);
router.use('/workflows', workflowRoutes);
router.use('/reports', reportRoutes);
router.use('/notifications', notificationRoutes);
router.use('/tasks', taskRoutes);
router.use('/hr', staffRoutes);
router.use('/sops', sopRoutes);
router.use('/', agreementRoutes);
router.use('/leadbyte', leadbyteRoutes);
router.use('/ad-spend', adSpendRoutes);
router.use('/ad-accounts', adAccountRoutes);
// Outbound webhooks (plan phase 4). Before the '/'-mounted creativeRoutes.
router.use('/webhook-endpoints', webhookEndpointRoutes);
router.use('/api-keys', apiKeyRoutes);
router.use('/uploads', uploadRoutes);
// SOS is open to clients too — mount BEFORE creativeRoutes (which has a
// router-level requireRole('owner','ops_manager') that would otherwise
// 403 any client-token request matching its '/' prefix before /sos
// could pick it up).
router.use('/sos', sosHelpRoutes);
// Creative library (M2) — per-route guards; must precede creativeRoutes'
// router-level owner/ops guard so Finance can read the library.
router.use('/', creativeLibraryRoutes);
router.use('/', creativeRoutes);
router.use('/finance/bank-feed', bankFeedRoutes);
router.use('/finance/auto-invoice', autoInvoiceRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/agreement-templates', agreementTemplateRoutes);
