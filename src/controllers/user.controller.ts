import { Request, Response } from 'express';
import * as userService from '../services/user.service.js';

export async function getUsers(req: Request, res: Response) {
  const users = await userService.listUsers(req.user!);

  res.json({
    status: 'success',
    data: { users },
  });
}

export async function createUser(req: Request, res: Response) {
  const { email, name, password, role, clientId, allowedTabs } = req.body;
  const user = await userService.createUser(email, name, password, role, req.user!, clientId, allowedTabs);

  res.status(201).json({
    status: 'success',
    data: { user },
  });
}

// Sam (2026-05-28 follow-up): admin sets which tabs a portal user sees,
// from the Portal Users card on Client Detail. Service-layer no-ops if
// the target is a client_admin (admins always see everything).
export async function updateAllowedTabs(req: Request, res: Response) {
  const id = req.params.id as string;
  const { allowedTabs } = req.body;
  const user = await userService.updateUserAllowedTabs(id, allowedTabs ?? null, req.user!);
  res.json({ status: 'success', data: { user } });
}

export async function updateUser(req: Request, res: Response) {
  const id = req.params.id as string;
  const { name, role } = req.body;
  const user = await userService.updateUser(id, name, role, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

export async function updateRole(req: Request, res: Response) {
  const id = req.params.id as string;
  const { role } = req.body;
  const user = await userService.updateUserRole(id, role, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

export async function toggleActive(req: Request, res: Response) {
  const id = req.params.id as string;
  const user = await userService.toggleUserActive(id, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

// Sam (2026-06-17): permanently remove a portal user from the Portal Users
// card. Service enforces portal-role-only + can't-remove-self/primary-owner.
export async function deleteUser(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await userService.deleteUser(id, req.user!);
  res.json({ status: 'success', data: result });
}

// Sam (2026-06-10): admin resets a password for any client/staff user
// from User Management. Does not require the user's current password.
export async function resetPassword(req: Request, res: Response) {
  const id = req.params.id as string;
  const { newPassword } = req.body;
  const user = await userService.adminResetPassword(id, newPassword, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

// Sam (2026-06-18): send/re-send the branded portal welcome (invite) email
// to a portal user from the Portal Users card.
export async function sendWelcomeEmail(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await userService.sendWelcomeEmail(id, req.user!);

  res.json({
    status: 'success',
    data: result,
  });
}
