import { Router, type Router as RouterType } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rate-limit.middleware.js';
import { loginSchema, registerSchema, updateProfileSchema, changePasswordSchema, refreshTokenSchema } from '../types/index.js';

export const authRoutes: RouterType = Router();

authRoutes.post('/register', authLimiter, validate(registerSchema), authController.register);
authRoutes.post('/login', authLimiter, validate(loginSchema), authController.login);
authRoutes.post('/refresh', authLimiter, validate(refreshTokenSchema), authController.refresh);
authRoutes.get('/me', authMiddleware, authController.me);
authRoutes.patch('/me', authMiddleware, validate(updateProfileSchema), authController.updateProfile);
authRoutes.post('/change-password', authMiddleware, validate(changePasswordSchema), authController.changePassword);
