import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as permissionController from '../controllers/permission.controller.js';

export const permissionRoutes: RouterType = Router();

permissionRoutes.use(authMiddleware);

permissionRoutes.get('/', permissionController.list);
permissionRoutes.patch('/', requireRole('owner'), permissionController.update);
