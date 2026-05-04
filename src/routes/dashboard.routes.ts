import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as dashboardController from '../controllers/dashboard.controller.js';

export const dashboardRoutes: RouterType = Router();

dashboardRoutes.use(authMiddleware);
// All admin roles can view the dashboard. Client portal uses /portal/* routes.
dashboardRoutes.use(requireRole('owner', 'finance_admin', 'ops_manager', 'readonly'));

dashboardRoutes.get('/stats', dashboardController.stats);
dashboardRoutes.get('/leads-by-day', dashboardController.leadsByDay);
dashboardRoutes.get('/recent-activity', dashboardController.recentActivity);
