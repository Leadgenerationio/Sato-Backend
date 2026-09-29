import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import * as ctrl from '../controllers/webhook-endpoint.controller.js';

// Plan phase 4: outbound webhooks, Owner only. Mounted at /webhook-endpoints
// because /webhooks is already the unauthenticated INBOUND provider router.

export const webhookEndpointRoutes: RouterType = Router();
webhookEndpointRoutes.use(authMiddleware, requireRole('owner'));

const idParams = z.object({ id: uuidShape() });
const events = z.array(z.string().min(1).max(64)).min(1).max(20);

webhookEndpointRoutes.get('/', ctrl.list);
webhookEndpointRoutes.post('/', validate(z.object({
  body: z.object({
    url: z.string().trim().min(1).max(2048),
    events,
    description: z.string().max(255).nullable().optional(),
  }),
})), ctrl.create);
webhookEndpointRoutes.patch('/:id', validate(z.object({
  params: idParams,
  body: z.object({
    url: z.string().trim().min(1).max(2048).optional(),
    events: events.optional(),
    description: z.string().max(255).nullable().optional(),
    active: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  }),
})), ctrl.update);
webhookEndpointRoutes.delete('/:id', validate(z.object({ params: idParams })), ctrl.remove);
webhookEndpointRoutes.get('/:id/deliveries', validate(z.object({
  params: idParams,
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
})), ctrl.deliveries);
webhookEndpointRoutes.post('/:id/test', validate(z.object({ params: idParams })), ctrl.test);
webhookEndpointRoutes.post('/:id/deliveries/:deliveryId/redeliver', validate(z.object({
  params: z.object({ id: uuidShape(), deliveryId: uuidShape() }),
})), ctrl.redeliver);
