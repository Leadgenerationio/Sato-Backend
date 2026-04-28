import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as bankFeed from '../controllers/bank-feed.controller.js';

export const bankFeedRoutes: RouterType = Router();

bankFeedRoutes.use(authMiddleware);
// Bank-feed is finance data — restrict to owner + finance_admin
bankFeedRoutes.use(requireRole('owner', 'finance_admin'));

// Transactions
bankFeedRoutes.get('/transactions', bankFeed.listTransactions);
bankFeedRoutes.patch('/transactions/:id/category', bankFeed.categorizeTransaction);

// Categories
bankFeedRoutes.get('/categories', bankFeed.listCategories);
bankFeedRoutes.post('/categories', bankFeed.createCategory);
bankFeedRoutes.delete('/categories/:id', bankFeed.deleteCategory);

// Vendor rules
bankFeedRoutes.get('/rules', bankFeed.listRules);
bankFeedRoutes.delete('/rules/:id', bankFeed.deleteRule);

// Manual sync trigger + last-sync status
bankFeedRoutes.post('/sync', bankFeed.syncNow);
bankFeedRoutes.get('/sync/status', bankFeed.syncStatus);
