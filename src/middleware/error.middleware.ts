import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    // Some controllers attach extra context via .code (machine-readable error
    // ID) or .errors / .issues (Zod-style array of problems). Surface those in
    // the JSON response when present so the FE can show useful per-field
    // messages instead of just the generic top-level message.
    const body: Record<string, unknown> = {
      status: 'error',
      message: err.message,
    };
    const anyErr = err as AppError & {
      code?: string;
      errors?: unknown;
      issues?: unknown;
    };
    if (anyErr.code) body.code = anyErr.code;
    if (anyErr.errors !== undefined) body.errors = anyErr.errors;
    if (anyErr.issues !== undefined) body.issues = anyErr.issues;
    res.status(err.statusCode).json(body);
    return;
  }

  logger.error({ err }, 'Unhandled error');

  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}
