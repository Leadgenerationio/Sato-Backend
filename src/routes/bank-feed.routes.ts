import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as bankFeed from '../controllers/bank-feed.controller.js';

export const bankFeedRoutes: RouterType = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'must be ISO date');

const categorizeSchema = z.object({
  body: z.object({
    categoryId: z.string().nullable().optional(),
    learnRule: z.boolean().optional(),
    applyRetroactively: z.boolean().optional(),
  }),
});

const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    bucket: z.enum(['fixed', 'one_off']),
    color: z.string().max(20).optional(),
  }),
});

const syncNowSchema = z.object({
  body: z.object({
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
  }),
});

bankFeedRoutes.use(authMiddleware);
// Bank-feed is finance data — restrict to owner + finance_admin
bankFeedRoutes.use(requireRole('owner', 'finance_admin'));

// Transactions
bankFeedRoutes.get('/transactions', bankFeed.listTransactions);
bankFeedRoutes.patch('/transactions/:id/category', validate(categorizeSchema), bankFeed.categorizeTransaction);

// Categories
bankFeedRoutes.get('/categories', bankFeed.listCategories);
bankFeedRoutes.post('/categories', validate(createCategorySchema), bankFeed.createCategory);
bankFeedRoutes.delete('/categories/:id', bankFeed.deleteCategory);

// Vendor rules
bankFeedRoutes.get('/rules', bankFeed.listRules);
bankFeedRoutes.delete('/rules/:id', bankFeed.deleteRule);

// Manual sync trigger + last-sync status
bankFeedRoutes.post('/sync', validate(syncNowSchema), bankFeed.syncNow);
bankFeedRoutes.get('/sync/status', bankFeed.syncStatus);
