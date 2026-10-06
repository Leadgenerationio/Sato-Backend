import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import * as ctrl from '../controllers/ad-account-links.controller.js';
import { apiKeyOrJwt, allow, apiKeyRateLimit } from '../middleware/api-key.middleware.js';

// Sam S13 (2026-09-29): bulk "link ad accounts to clients and campaigns".
// Matching is on (platform, accountId) only — never the account name.

export const adAccountRoutes: RouterType = Router();
adAccountRoutes.use(authMiddleware);

const listSchema = z.object({
  query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
});

const bulkLinkSchema = z.object({
  body: z.object({
    links: z.array(z.object({
      platform: z.string().trim().min(1).max(50),
      accountId: z.string().trim().min(1).max(100),
      clientId: uuidShape().nullable(),
      campaignId: uuidShape().nullable().optional(),
      accountName: z.string().max(255).nullable().optional(),
      currency: z.string().length(3).nullable().optional(),
    })).min(1).max(500),
  }),
});

adAccountRoutes.get('/', requireRole('owner', 'ops_manager', 'finance_admin'), validate(listSchema), ctrl.list);
adAccountRoutes.put('/links', requireRole('owner', 'ops_manager'), validate(bulkLinkSchema), ctrl.bulkLink);

// Phase 3 (docs/creative-library-and-api-plan.md): scheduled pull of ads and
// creatives from Meta / Taboola. Status for the Link ad accounts screen, and
// a per-account "Sync now". :id is the client_ad_accounts row id.
const syncNowSchema = z.object({ params: z.object({ id: uuidShape() }) });
adAccountRoutes.get('/sync-status', requireRole('owner', 'ops_manager', 'finance_admin'), ctrl.syncStatus);
adAccountRoutes.post('/:id/sync-now', requireRole('owner', 'ops_manager'), validate(syncNowSchema), ctrl.syncNow);

// Mounted at /clients BEFORE clientRoutes (whose GET /:id would otherwise
// treat "lookup" as a client id). Kept out of client.routes.ts on purpose.
export const clientLookupRoutes: RouterType = Router();
const lookupSchema = z.object({
  query: z.object({
    platform: z.string().trim().min(1).max(50),
    accountId: z.string().trim().min(1).max(100),
  }),
});
// Also on the public API (X-API-Key, scope clients:read) — plan phase 2.
clientLookupRoutes.get(
  '/lookup',
  apiKeyOrJwt,
  apiKeyRateLimit,
  allow(['owner', 'ops_manager', 'finance_admin'], 'clients:read'),
  validate(lookupSchema),
  ctrl.lookup,
);

// POST /clients/:id/ad-accounts — link one ad account to this client (public
// API scope ad_accounts:write, or owner/ops JWT). Same upsert as the bulk
// screen, so linking an account that belongs to another client moves it.
export const linkOneSchema = z.object({
  params: z.object({ id: uuidShape() }),
  body: z.object({
    platform: z.string().trim().min(1).max(50),
    accountId: z.string().trim().min(1).max(100),
    campaignId: uuidShape().nullable().optional(),
    accountName: z.string().max(255).nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    // A link that would move the account from another client is refused unless this is true.
    confirmMove: z.boolean().optional(),
  }),
});
clientLookupRoutes.post(
  '/:id/ad-accounts',
  apiKeyOrJwt,
  apiKeyRateLimit,
  allow(['owner', 'ops_manager'], 'ad_accounts:write'),
  validate(linkOneSchema),
  ctrl.linkOne,
);
