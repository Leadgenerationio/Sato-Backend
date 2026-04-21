import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import * as sopController from '../controllers/sop.controller.js';

export const sopRoutes: RouterType = Router();

sopRoutes.use(authMiddleware);

sopRoutes.get('/', sopController.listSops);
sopRoutes.get('/:id', sopController.getSop);
sopRoutes.post('/', sopController.createSop);
sopRoutes.put('/:id', sopController.updateSop);
