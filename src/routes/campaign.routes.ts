import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as campaignController from '../controllers/campaign.controller.js';

export const campaignRoutes: RouterType = Router();

campaignRoutes.use(authMiddleware);
campaignRoutes.use(requireRole('owner', 'ops_manager'));

campaignRoutes.get('/', campaignController.listCampaigns);
campaignRoutes.get('/:id', campaignController.getCampaign);
campaignRoutes.get('/:id/sources', campaignController.listTrafficSources);
