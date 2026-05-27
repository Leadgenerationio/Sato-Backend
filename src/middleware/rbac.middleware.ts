import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import type { UserRole } from '../types/index.js';

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError('Insufficient permissions');
    }

    next();
  };
}

// Sam (2026-05-27 portal meeting): client_admin is a sub-role of client
// with permission to manage other portal users + mark the agreement
// signed externally. Both flow through the existing /portal/* route tree,
// so any guard that accepts 'client' should also accept 'client_admin'.
// Use isPortalUser() instead of requireRole('client') for portal routes
// that should remain accessible to both.
export function isPortalUser(role: UserRole): boolean {
  return role === 'client' || role === 'client_admin';
}

// Portal-side guard for routes that only client_admin should hit
// (e.g. POST /portal/users, POST /portal/agreement/external).
export function requireClientAdmin() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new UnauthorizedError();
    if (req.user.role !== 'client_admin') {
      throw new ForbiddenError(
        'Only the client admin for this account can perform this action',
      );
    }
    next();
  };
}
