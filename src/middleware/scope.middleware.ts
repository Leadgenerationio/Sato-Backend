import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

/**
 * Ensures the request is scoped to the user's business.
 * Sets req.scopedBusinessId for use in services/queries.
 * Owner bypasses — sees all businesses.
 */
export function scopeToBusiness(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new UnauthorizedError();

  if (req.user.role === 'owner') {
    // Owner can access all businesses — no filter
    (req as any).scopedBusinessId = null;
  } else if (req.user.businessId) {
    (req as any).scopedBusinessId = req.user.businessId;
  } else {
    throw new ForbiddenError('No business assigned to your account');
  }

  next();
}

/**
 * Ensures client-role users can only access their own data.
 * Sets req.scopedClientId for use in services/queries.
 * Non-client roles bypass — no client filter.
 */
export function scopeToClient(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new UnauthorizedError();

  if (req.user.role === 'client') {
    if (!req.user.clientId) {
      throw new ForbiddenError('No client assigned to your account');
    }
    (req as any).scopedClientId = req.user.clientId;
  } else {
    // Internal roles — no client scoping
    (req as any).scopedClientId = null;
  }

  next();
}

/**
 * Combined: business + client scoping in one middleware.
 * Use on any data route that needs both.
 */
export function scopeToBusinessAndClient(req: Request, res: Response, next: NextFunction) {
  scopeToBusiness(req, res, () => {
    scopeToClient(req, res, next);
  });
}
