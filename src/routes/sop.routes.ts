import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as sopController from '../controllers/sop.controller.js';

export const sopRoutes: RouterType = Router();

const createSopSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300),
    })
    .passthrough(),
});

const updateSopSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300).optional(),
    })
    .passthrough(),
});

sopRoutes.use(authMiddleware);

sopRoutes.get('/', sopController.listSops);
sopRoutes.get('/:id', sopController.getSop);
sopRoutes.post('/', validate(createSopSchema), sopController.createSop);
sopRoutes.put('/:id', validate(updateSopSchema), sopController.updateSop);
