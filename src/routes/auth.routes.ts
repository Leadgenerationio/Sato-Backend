import { Router, type Router as RouterType, type Request, type Response } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rate-limit.middleware.js';
import { logger } from '../utils/logger.js';
import { loginSchema, registerSchema, updateProfileSchema, changePasswordSchema, refreshTokenSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema } from '../types/index.js';

export const authRoutes: RouterType = Router();

authRoutes.post('/register', authLimiter, validate(registerSchema), authController.register);
authRoutes.post('/login', authLimiter, validate(loginSchema), authController.login);
authRoutes.post('/refresh', authLimiter, validate(refreshTokenSchema), authController.refresh);
// Best-effort logout — no token denylist (would need a schema change).
// Idempotent: succeeds even when no Authorization header is present so the FE
// can call this on every sign-out path without conditional logic.
// TODO: needs schema change to be fully safe — see audit 2026-05-03
authRoutes.post('/logout', (req: Request, res: Response) => {
  const userId = req.user?.userId ?? null;
  logger.info({ userId }, 'User logout (best-effort, no denylist)');
  res.status(200).json({ status: 'success', data: { message: 'Logged out' } });
});
// Forgot-password OTP (Sam 2026-06-10) — public, rate-limited. The user is
// logged out, so no authMiddleware. forgot-password never reveals whether an
// email exists.
authRoutes.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
authRoutes.post('/verify-reset-code', authLimiter, validate(verifyResetCodeSchema), authController.verifyResetCode);
authRoutes.post('/reset-password', authLimiter, validate(resetPasswordSchema), authController.resetPassword);

authRoutes.get('/me', authMiddleware, authController.me);
authRoutes.patch('/me', authMiddleware, validate(updateProfileSchema), authController.updateProfile);
authRoutes.post('/change-password', authMiddleware, validate(changePasswordSchema), authController.changePassword);
