import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as settings from '../services/business-settings.service.js';

// Sam feedback 2026-09-29 (S4): Owner-only business settings.
export const settingsRoutes: RouterType = Router();
settingsRoutes.use(authMiddleware);
settingsRoutes.use(requireRole('owner'));

settingsRoutes.get('/xero-tax-types', async (req: Request, res: Response) => {
  const taxTypes = await settings.getXeroTaxTypes(req.user!.businessId);
  res.json({ status: 'success', data: { taxTypes, defaults: settings.DEFAULT_XERO_TAX_TYPES, known: settings.KNOWN_XERO_TAX_TYPES } });
});

const putSchema = z.object({ body: z.object({ taxTypes: z.record(z.string(), z.string().max(40)) }) });

settingsRoutes.put('/xero-tax-types', validate(putSchema), async (req: Request, res: Response) => {
  if (!req.user!.businessId) { res.status(400).json({ status: 'error', message: 'No business on this account.' }); return; }
  const taxTypes = await settings.setXeroTaxTypes(req.user!.businessId, req.body.taxTypes, req.user!.userId);
  res.json({ status: 'success', data: { taxTypes } });
});
