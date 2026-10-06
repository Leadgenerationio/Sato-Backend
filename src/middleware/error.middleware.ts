import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { ApiError, apiErrorBody, toApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId ?? null;

  // The public API / MCP error shape (spec v1.0 §3): code, message, hint,
  // fields, retryable, requestId.
  if (err instanceof ApiError) {
    if (err.retryAfter !== undefined) res.setHeader('Retry-After', String(err.retryAfter));
    res.status(err.statusCode).json(apiErrorBody(err, requestId));
    return;
  }

  if (err instanceof AppError) {
    // Some controllers attach extra context via .code (machine-readable error
    // ID) or .errors / .issues (Zod-style array of problems). Surface those in
    // the JSON response when present so the FE can show useful per-field
    // messages instead of just the generic top-level message. A legacy .code
    // is kept as-is (the portal reads some of them); without one, the shared
    // code for the status is added.
    const shared = apiErrorBody(err, requestId);
    const body: Record<string, unknown> = {
      ...shared,
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

  logger.error({ err, requestId }, 'Unhandled error');

  res.status(500).json({
    ...apiErrorBody(toApiError(err), requestId),
    message: 'Internal server error',
  });
}
