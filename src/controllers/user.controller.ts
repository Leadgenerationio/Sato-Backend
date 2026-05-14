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
  const { email, name, password, role, clientId } = req.body;
  const user = await userService.createUser(email, name, password, role, req.user!, clientId);

  res.status(201).json({
    status: 'success',
    data: { user },
  });
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
