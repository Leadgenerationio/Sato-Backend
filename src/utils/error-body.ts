import { AppError } from './errors.js';
import { ApiError } from './api-error.js';

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

/** The one error body used by REST (error middleware) and MCP (tool errors). */
export function buildErrorBody(err: unknown, requestId?: string): { status: number; body: Record<string, unknown> } {
  if (err instanceof AppError) {
    // Some controllers attach extra context via .code (machine-readable error
    // ID) or .errors / .issues (Zod-style array of problems). Surface those in
    // the JSON response when present so the FE can show useful per-field
    // messages instead of just the generic top-level message.
    const body: Record<string, unknown> = { status: 'error', message: err.message };
    const anyErr = err as AppError & { code?: string; errors?: unknown; issues?: unknown };
    const code = anyErr.code ?? defaultCode(err.statusCode);
    if (code) body.code = code;
    if (anyErr.errors !== undefined) body.errors = anyErr.errors;
    if (anyErr.issues !== undefined) body.issues = anyErr.issues;
    if (err instanceof ApiError) {
      if (err.hint) body.hint = err.hint;
      if (err.fields) body.fields = err.fields;
      if (err.details) body.details = err.details;
      body.retryable = err.retryable;
    }
    if (requestId) body.requestId = requestId;
    return { status: err.statusCode, body };
  }
  return {
    status: 500,
    body: { status: 'error', code: 'internal_error', message: 'Internal server error', retryable: false, ...(requestId ? { requestId } : {}) },
  };
}
