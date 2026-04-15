import { Request, Response } from 'express';
import * as userService from '../services/user.service.js';

export function getUsers(req: Request, res: Response) {
  const users = userService.listUsers(req.user!);

  res.json({
    status: 'success',
    data: { users },
  });
}

export async function createUser(req: Request, res: Response) {
  const { email, name, password, role } = req.body;
  const user = await userService.createUser(email, name, password, role, req.user!);

  res.status(201).json({
    status: 'success',
    data: { user },
  });
}

export function updateUser(req: Request, res: Response) {
  const id = req.params.id as string;
  const { name, role } = req.body;
  const user = userService.updateUser(id, name, role, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

export function updateRole(req: Request, res: Response) {
  const id = req.params.id as string;
  const { role } = req.body;
  const user = userService.updateUserRole(id, role, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}

export function toggleActive(req: Request, res: Response) {
  const id = req.params.id as string;
  const user = userService.toggleUserActive(id, req.user!);

  res.json({
    status: 'success',
    data: { user },
  });
}
