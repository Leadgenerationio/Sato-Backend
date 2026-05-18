import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationQuerySchema } from '../types/index.js';
import * as campaignController from '../controllers/campaign.controller.js';
import * as clientCampaignsController from '../controllers/client-campaigns.controller.js';

export const campaignRoutes: RouterType = Router();

const linkClientSchema = z.object({
  body: z.object({
    clientId: z.string().uuid(),
    leadPrice: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
  }),
});

const updateCampaignSchema = z.object({
  body: z.object({
    costPerLead: z.number().nonnegative().nullable().optional(),
  }),
});

// Sam Loom #42-46 — leadreports.io-style traffic-source rows per campaign.
const createTrafficSourceSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    platform: z.string().max(100).optional(),
    accountId: z.string().max(100).optional(),
    catchrUrl: z.string().max(2000).optional(),
    isActive: z.boolean().optional(),
  }),
});
const updateTrafficSourceSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    platform: z.string().max(100).optional(),
    accountId: z.string().max(100).optional(),
    catchrUrl: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
    totalSpend: z.number().nonnegative().optional(),
    totalLeads: z.number().int().nonnegative().optional(),
  }),
});

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
campaignRoutes.patch('/:id', validate(updateCampaignSchema), campaignController.updateCampaign);
campaignRoutes.get('/:id/sources', campaignController.listTrafficSources);
campaignRoutes.get('/:id/deliveries', campaignController.listCampaignDeliveries);
campaignRoutes.post('/:id/sources', validate(createTrafficSourceSchema), campaignController.createTrafficSource);
campaignRoutes.patch('/:id/sources/:sourceId', validate(updateTrafficSourceSchema), campaignController.updateTrafficSource);
campaignRoutes.delete('/:id/sources/:sourceId', campaignController.deleteTrafficSource);

// Slice 2 Day 1: many-to-many client ↔ campaign links. Campaign now = vertical;
// these endpoints manage the buyer list underneath it.
campaignRoutes.get('/:id/clients', clientCampaignsController.listForCampaign);
campaignRoutes.post('/:id/clients', validate(linkClientSchema), clientCampaignsController.link);
campaignRoutes.delete('/:id/clients/:clientId', clientCampaignsController.unlink);
