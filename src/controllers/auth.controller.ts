import { Request, Response } from 'express';
import * as authService from '../services/auth.service.js';
import * as userService from '../services/user.service.js';
import * as passwordResetService from '../services/password-reset.service.js';

export async function register(req: Request, res: Response) {
  const { email, password, name, role } = req.body;
  const result = await authService.registerUser(email, password, name, role);

  res.status(201).json({
    status: 'success',
    data: result,
  });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  const result = await authService.loginUser(email, password);

  res.json({
    status: 'success',
    data: result,
  });
}

export async function refresh(req: Request, res: Response) {
  const { refreshToken } = req.body;
  const payload = authService.verifyRefreshToken(refreshToken);
  const tokens = authService.generateTokens(payload);

  res.json({
    status: 'success',
    data: { tokens },
  });
}

export async function me(req: Request, res: Response) {
  const user = await authService.getUserById(req.user!.userId);

  res.json({
    status: 'success',
    data: { user },
  });
}

export async function updateProfile(req: Request, res: Response) {
  const { name } = req.body;
  const user = await userService.updateOwnProfile(req.user!.userId, name);

  res.json({
    status: 'success',
    data: { user },
  });
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = req.body;
  await userService.changeOwnPassword(req.user!.userId, currentPassword, newPassword);

  res.json({
    status: 'success',
    data: { message: 'Password updated' },
  });
}

// ─── Forgot-password OTP (Sam 2026-06-10) ───

// Step 1 — always returns success regardless of whether the email exists
// (no account enumeration).
export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body;
  await passwordResetService.requestPasswordReset(email);

  res.json({
    status: 'success',
    data: { message: 'If that email is registered, a reset code has been sent.' },
  });
}

// Step 2 — verify the 6-digit code, returns a short-lived reset token.
export async function verifyResetCode(req: Request, res: Response) {
  const { email, code } = req.body;
  const { resetToken } = await passwordResetService.verifyResetCode(email, code);

  res.json({
    status: 'success',
    data: { resetToken },
  });
}

// Step 3 — set the new password using the reset token.
export async function resetPassword(req: Request, res: Response) {
  const { resetToken, newPassword } = req.body;
  await passwordResetService.resetPassword(resetToken, newPassword);

  res.json({
    status: 'success',
    data: { message: 'Password updated' },
  });
}
