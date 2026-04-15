import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as userController from '../controllers/user.controller.js';

export const userRoutes: RouterType = Router();

userRoutes.use(authMiddleware);
userRoutes.use(requireRole('owner'));

userRoutes.get('/', userController.getUsers);
userRoutes.post('/', userController.createUser);
userRoutes.put('/:id', userController.updateUser);
userRoutes.patch('/:id/role', userController.updateRole);
userRoutes.patch('/:id/toggle-active', userController.toggleActive);
