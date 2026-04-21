import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as ctrl from '../controllers/ad-spend.controller.js';

export const adSpendRoutes: RouterType = Router();

adSpendRoutes.use(authMiddleware);

const finance = requireRole('owner', 'finance_admin');

adSpendRoutes.get('/status', finance, ctrl.status);
adSpendRoutes.get('/', finance, ctrl.list);
adSpendRoutes.get('/summary', finance, ctrl.summary);
adSpendRoutes.post('/sync', finance, ctrl.syncNow);
