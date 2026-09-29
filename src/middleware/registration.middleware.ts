import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';

/**
 * Public self-registration hands an unauthenticated caller a working account and
 * tokens, with a role of their choosing (finance_admin / ops_manager / readonly)
 * and no business. Sam feedback 2026-09-29 (S8): nothing in the product uses it
 * (staff are added by an owner from Settings → User Management), so in production
 * it is closed unless ALLOW_PUBLIC_REGISTRATION=true is set on purpose.
 *
 * Read at request time, not import time, so tests and deploys can flip it.
 */
export function isPublicRegistrationOpen(e: NodeJS.ProcessEnv = process.env): boolean {
  return e.NODE_ENV !== 'production' || e.ALLOW_PUBLIC_REGISTRATION === 'true';
}

class RegistrationClosedError extends AppError {
  code = 'registration_closed';
  constructor() {
    super(403, 'Sign-up is closed. Ask an owner to add you from Settings → User Management.');
    Object.setPrototypeOf(this, RegistrationClosedError.prototype);
  }
}

export function requirePublicRegistration(_req: Request, _res: Response, next: NextFunction) {
  if (!isPublicRegistrationOpen()) return next(new RegistrationClosedError());
  next();
}
