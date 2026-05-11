import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as reportController from '../controllers/report.controller.js';

export const reportRoutes: RouterType = Router();

reportRoutes.use(authMiddleware);
reportRoutes.use(requireRole('owner', 'finance_admin'));

reportRoutes.get('/campaign-performance', reportController.campaignPerformance);
reportRoutes.get('/client-pnl', reportController.clientPnl);
reportRoutes.get('/supplier-performance', reportController.supplierPerformance);
reportRoutes.get('/financial-overview', reportController.financialOverview);
reportRoutes.get('/pnl-summary', reportController.pnlSummary);

// Slice 4 Day 1: the one report that folds the other five (Sam #72-85).
// Existing endpoints stay until the frontend has fully migrated off them.
reportRoutes.get('/unified', reportController.unifiedReport);
