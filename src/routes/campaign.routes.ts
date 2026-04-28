import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationQuerySchema } from '../types/index.js';
import * as campaignController from '../controllers/campaign.controller.js';

export const campaignRoutes: RouterType = Router();

const listCampaignsQuerySchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.string().optional(),
    vertical: z.string().optional(),
    search: z.string().optional(),
    type: z.string().optional(),
  }),
});

campaignRoutes.use(authMiddleware);
campaignRoutes.use(requireRole('owner', 'ops_manager'));

campaignRoutes.get('/', validate(listCampaignsQuerySchema), campaignController.listCampaigns);
campaignRoutes.get('/:id', campaignController.getCampaign);
campaignRoutes.get('/:id/sources', campaignController.listTrafficSources);
