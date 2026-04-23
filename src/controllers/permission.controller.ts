import { Request, Response } from 'express';
import { getPermissions, updatePermission } from '../data/permissions.js';

export function list(_req: Request, res: Response) {
  res.json({ status: 'success', data: { permissions: getPermissions() } });
}

export function update(req: Request, res: Response) {
  const { permission, role, allowed } = req.body;

  if (!permission || !role || typeof allowed !== 'boolean') {
    res.status(400).json({ status: 'error', message: 'permission, role, and allowed are required' });
    return;
  }

  // Owner role permissions are immutable — Owner always has full access
  if (role === 'owner') {
    res.status(403).json({ status: 'error', message: 'Owner permissions are immutable' });
    return;
  }

  const entry = updatePermission(permission, role, allowed);
  if (!entry) {
    res.status(404).json({ status: 'error', message: 'Permission not found' });
    return;
  }

  res.json({ status: 'success', data: { permission: entry } });
}
