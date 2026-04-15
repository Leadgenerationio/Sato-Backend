import { Router, type Router as RouterType } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { loginSchema, registerSchema } from '../types/index.js';

export const authRoutes: RouterType = Router();

authRoutes.post('/register', validate(registerSchema), authController.register);
authRoutes.post('/login', validate(loginSchema), authController.login);
authRoutes.post('/refresh', authController.refresh);
authRoutes.get('/me', authMiddleware, authController.me);
