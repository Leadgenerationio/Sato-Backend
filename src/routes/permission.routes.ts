import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as permissionController from '../controllers/permission.controller.js';

export const permissionRoutes: RouterType = Router();

const updatePermissionSchema = z.object({
  body: z.object({
    permission: z.string().min(1).max(100),
    role: z.enum(['owner', 'finance_admin', 'ops_manager', 'client', 'readonly']),
    allowed: z.boolean(),
  }),
});

permissionRoutes.use(authMiddleware);

permissionRoutes.get('/', permissionController.list);
permissionRoutes.patch('/', requireRole('owner'), validate(updatePermissionSchema), permissionController.update);
