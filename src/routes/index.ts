import { Router, type Router as RouterType } from 'express';
import { authRoutes } from './auth.routes.js';
import { userRoutes } from './user.routes.js';
import { permissionRoutes } from './permission.routes.js';
import { integrationRoutes } from './integration.routes.js';
import { authLimiter } from '../middleware/rate-limit.middleware.js';

export const router: RouterType = Router();

router.use('/auth', authLimiter, authRoutes);
router.use('/users', userRoutes);
router.use('/permissions', permissionRoutes);
router.use('/integrations', integrationRoutes);
