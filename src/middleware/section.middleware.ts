import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';
import { getSection } from '../config/sections.js';
import { isSectionAllowed } from '../services/permission.service.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Role Access Matrix enforcement (S7). Mounted in front of a section's router
 * in routes/index.ts, where the router's own authMiddleware hasn't run yet —
 * so it reads the bearer token itself. No/invalid token → pass through and
 * let the router's authMiddleware return its usual 401.
 *
 * Only restricts: a role outside the section's floor falls through to the
 * route's requireRole(), which stays the real gate.
 */
export function requireSection(sectionKey: string) {
  if (!getSection(sectionKey)) throw new Error(`requireSection: unknown section "${sectionKey}"`);

  return async (req: Request, _res: Response, next: NextFunction) => {
    let user = req.user;
    if (!user) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return next();
      try {
        user = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
      } catch {
        return next();
      }
    }
    try {
      if (await isSectionAllowed(user, sectionKey)) return next();
    } catch (err) {
      return next(err);
    }
    next(new ForbiddenError(`Your role doesn't have access to ${getSection(sectionKey)!.label}. Ask an Owner to change it in Settings → User Management.`));
  };
}
