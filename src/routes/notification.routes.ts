import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import * as notificationController from '../controllers/notification.controller.js';

export const notificationRoutes: RouterType = Router();

notificationRoutes.use(authMiddleware);

notificationRoutes.get('/', notificationController.listNotifications);
notificationRoutes.put('/read-all', notificationController.markAllAsRead);
notificationRoutes.put('/:id/read', notificationController.markAsRead);
