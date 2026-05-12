import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as sosController from '../controllers/sos-help.controller.js';

export const sosHelpRoutes: RouterType = Router();

const createSosSchema = z.object({
  body: z.object({
    pagePath: z.string().max(500).optional(),
    message: z.string().max(2000).optional(),
  }),
});

sosHelpRoutes.use(authMiddleware);

// Any authed user — including clients — can press SOS. The button is a
// support escape hatch, RBAC would defeat the purpose.
sosHelpRoutes.post('/', validate(createSosSchema), sosController.createSos);

// Only internal roles can see/resolve the queue.
const internalRoles = requireRole('owner', 'ops_manager', 'finance_admin');
sosHelpRoutes.get('/', internalRoles, sosController.listSos);
sosHelpRoutes.post('/:id/resolve', internalRoles, sosController.resolveSos);
