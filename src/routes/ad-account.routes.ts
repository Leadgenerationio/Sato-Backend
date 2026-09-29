import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import * as ctrl from '../controllers/ad-account-links.controller.js';

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

// Mounted at /clients BEFORE clientRoutes (whose GET /:id would otherwise
// treat "lookup" as a client id). Kept out of client.routes.ts on purpose.
export const clientLookupRoutes: RouterType = Router();
const lookupSchema = z.object({
  query: z.object({
    platform: z.string().trim().min(1).max(50),
    accountId: z.string().trim().min(1).max(100),
  }),
});
clientLookupRoutes.get(
  '/lookup',
  authMiddleware,
  requireRole('owner', 'ops_manager', 'finance_admin'),
  validate(lookupSchema),
  ctrl.lookup,
);
