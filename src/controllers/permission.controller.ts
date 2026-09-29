import { Request, Response } from 'express';
import * as permissionService from '../services/permission.service.js';
import { ALL_ROLES } from '../config/sections.js';
import type { UserRole } from '../types/index.js';

export async function list(req: Request, res: Response) {
  const sections = await permissionService.getMatrix(req.user!.businessId);
  res.json({
    status: 'success',
    data: {
      roles: ALL_ROLES,
      sections,
      // Pre-S7 shape, kept so a Settings page deployed before this API
      // still renders while the two deploys roll out.
      permissions: permissionService.toLegacy(sections),
    },
  });
}

export async function me(req: Request, res: Response) {
  const sections = await permissionService.getSectionsFor(req.user!);
  res.json({ status: 'success', data: { role: req.user!.role, sections } });
}

export async function update(req: Request, res: Response) {
  const { section, permission, role, allowed } = req.body as {
    section?: string; permission?: string; role: UserRole; allowed: boolean;
  };
  const key = section ?? permission;
  if (!key) {
    res.status(400).json({ status: 'error', message: 'section, role, and allowed are required' });
    return;
  }
  try {
    const updated = await permissionService.setPermission(req.user!, key, role, allowed);
    res.json({
      status: 'success',
      data: { section: updated, permission: permissionService.toLegacy([updated])[0] },
    });
  } catch (err) {
    if (err instanceof permissionService.PermissionChangeError) {
      res.status(err.statusCode).json({ status: 'error', message: err.message });
      return;
    }
    throw err;
  }
}

export async function changes(req: Request, res: Response) {
  if (!req.user!.businessId) {
    res.json({ status: 'success', data: { changes: [] } });
    return;
  }
  const rows = await permissionService.listChanges(req.user!.businessId);
  res.json({ status: 'success', data: { changes: rows } });
}
