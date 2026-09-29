import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as cleanup from '../services/data-cleanup.service.js';

// Settings → Clean up (S8 + N6). Owner only.
export const adminCleanupRoutes: RouterType = Router();

const idList = z.array(z.guid()).max(500).optional();
const applySchema = z.object({
  body: z.object({
    deactivateUserIds: idList,
    demoteOwnerIds: z.array(z.object({ id: z.guid(), role: z.enum(cleanup.DEMOTE_ROLES) })).max(50).optional(),
    archiveSosIds: idList,
    archiveSopIds: idList,
    archiveStaffIds: idList,
    trimContacts: z.boolean().optional(),
  }),
});

adminCleanupRoutes.use(authMiddleware);
adminCleanupRoutes.use(requireRole('owner'));

adminCleanupRoutes.get('/', async (req: Request, res: Response) => {
  const report = await cleanup.getCleanupReport(req.user!);
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'success', data: report });
});

adminCleanupRoutes.post('/apply', validate(applySchema), async (req: Request, res: Response) => {
  const result = await cleanup.applyCleanup(req.user!, req.body);
  res.json({ status: 'success', data: result });
});
