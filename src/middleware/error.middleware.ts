import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';

// Codes for plain AppErrors that carry none, so every error has one. Additive:
// a code an error already has is never changed.
function defaultCode(status: number): string | undefined {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return undefined;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const requestId = res.locals.requestId as string | undefined;
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
    const code = anyErr.code ?? defaultCode(err.statusCode);
    if (code) body.code = code;
    if (err instanceof ApiError) {
      if (err.hint) body.hint = err.hint;
      if (err.fields) body.fields = err.fields;
      if (err.details) body.details = err.details;
      body.retryable = err.retryable;
    }
    if (requestId) body.requestId = requestId;
    if (anyErr.errors !== undefined) body.errors = anyErr.errors;
    if (anyErr.issues !== undefined) body.issues = anyErr.issues;
    res.status(err.statusCode).json(body);
    return;
  }

  logger.error({ err }, 'Unhandled error');

  res.status(500).json({
    status: 'error',
    code: 'internal_error',
    message: 'Internal server error',
    retryable: false,
    ...(requestId ? { requestId } : {}),
  });
}
