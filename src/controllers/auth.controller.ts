import { Request, Response } from 'express';
import * as authService from '../services/auth.service.js';
import * as userService from '../services/user.service.js';

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
