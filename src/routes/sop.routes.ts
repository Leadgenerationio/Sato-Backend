import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as sopController from '../controllers/sop.controller.js';

export const sopRoutes: RouterType = Router();

const createSopSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300),
    })
    .passthrough(),
});

const updateSopSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300).optional(),
    })
    .passthrough(),
});

sopRoutes.use(authMiddleware);

// SOPs document internal procedures — clients/readonly should not see them.
const internalRoles = requireRole('owner', 'ops_manager', 'finance_admin');

sopRoutes.get('/', internalRoles, sopController.listSops);
sopRoutes.get('/:id', internalRoles, sopController.getSop);
sopRoutes.post('/', internalRoles, validate(createSopSchema), sopController.createSop);
sopRoutes.put('/:id', internalRoles, validate(updateSopSchema), sopController.updateSop);
