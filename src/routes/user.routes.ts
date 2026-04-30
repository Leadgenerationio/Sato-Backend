import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as userController from '../controllers/user.controller.js';

export const userRoutes: RouterType = Router();

const roleEnum = z.enum(['owner', 'finance_admin', 'ops_manager', 'client', 'readonly']);

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    password: z.string().min(6).max(200),
    role: roleEnum,
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    role: roleEnum.optional(),
  }),
});

const updateRoleSchema = z.object({
  body: z.object({ role: roleEnum }),
});

userRoutes.use(authMiddleware);
userRoutes.use(requireRole('owner'));

userRoutes.get('/', userController.getUsers);
userRoutes.post('/', validate(createUserSchema), userController.createUser);
userRoutes.put('/:id', validate(updateUserSchema), userController.updateUser);
userRoutes.patch('/:id/role', validate(updateRoleSchema), userController.updateRole);
userRoutes.patch('/:id/toggle-active', userController.toggleActive);
