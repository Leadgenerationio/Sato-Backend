import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as permissionController from '../controllers/permission.controller.js';
import { ALL_ROLES } from '../config/sections.js';

export const permissionRoutes: RouterType = Router();

// `section` is the S7 key (e.g. 'bank_feed'); `permission` is the legacy
// field the pre-S7 Settings page sends (the section label). Either works.
const updatePermissionSchema = z.object({
  body: z.object({
    section: z.string().min(1).max(100).optional(),
    permission: z.string().min(1).max(100).optional(),
    role: z.enum(ALL_ROLES as [typeof ALL_ROLES[number], ...typeof ALL_ROLES]),
    allowed: z.boolean(),
  }).refine((b) => !!(b.section ?? b.permission), { message: 'section is required' }),
});

permissionRoutes.use(authMiddleware);

permissionRoutes.get('/me', permissionController.me);
permissionRoutes.get('/', requireRole('owner', 'finance_admin', 'ops_manager', 'readonly'), permissionController.list);
permissionRoutes.get('/changes', requireRole('owner'), permissionController.changes);
permissionRoutes.patch('/', requireRole('owner'), validate(updatePermissionSchema), permissionController.update);
permissionRoutes.put('/', requireRole('owner'), validate(updatePermissionSchema), permissionController.update);
