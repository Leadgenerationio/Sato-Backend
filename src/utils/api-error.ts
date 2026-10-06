import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

// One error shape for the public REST API and the MCP tools (spec v1.0 §3):
//   { status: 'error', code, message, hint, fields, retryable, requestId }
// MCP tool results add isError: true. REST and MCP use the same codes.

export const API_ERROR_CODES = {
  unauthorized: 401,
  insufficient_scope: 403,
  not_found: 404,
  validation_failed: 400,
  account_not_linked: 422,
  account_client_mismatch: 422,
  campaign_client_mismatch: 422,
  move_requires_confirm: 409,
  duplicate: 409,
  file_too_large: 413,
  unsupported_type: 415,
  source_unreachable: 422,
  upload_incomplete: 409,
  rate_limited: 429,
  internal_error: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/** Worth sending the same call again later, unchanged. */
const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set(['rate_limited', 'internal_error', 'source_unreachable']);

export interface ApiErrorOptions {
  /** What to do next, written for the bot reading it. */
  hint?: string;
  /** Input fields at fault (for validation_failed and the mismatch codes). */
  fields?: string[];
  retryable?: boolean;
  /** Seconds, for rate_limited. */
  retryAfter?: number;
  /** Extra machine-readable context, e.g. the existing ID for duplicate. */
  details?: Record<string, unknown>;
}

export class ApiError extends AppError {
  readonly code: ApiErrorCode;
  readonly hint: string | null;
  readonly fields: string[];
  readonly retryable: boolean;
  readonly retryAfter: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApiErrorCode, message: string, opts: ApiErrorOptions = {}) {
    super(API_ERROR_CODES[code], message);
    Object.setPrototypeOf(this, ApiError.prototype);
    this.code = code;
    this.hint = opts.hint ?? null;
    this.fields = opts.fields ?? [];
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.retryAfter = opts.retryAfter;
    this.details = opts.details;
  }
}

export interface ApiErrorBody {
  status: 'error';
  code: ApiErrorCode;
  message: string;
  hint: string | null;
  fields: string[];
  retryable: boolean;
  requestId: string | null;
  retryAfter?: number;
  details?: Record<string, unknown>;
}

const isApiErrorCode = (c: unknown): c is ApiErrorCode => typeof c === 'string' && c in API_ERROR_CODES;

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'insufficient_scope';
  if (status === 404) return 'not_found';
  if (status === 413) return 'file_too_large';
  if (status === 415) return 'unsupported_type';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'validation_failed';
  return 'internal_error';
}

/**
 * Any thrown value → an ApiError. Older code throws AppError with a status
 * (and sometimes a .code); Zod errors become validation_failed with the
 * fields at fault. Anything else is internal_error, with the message hidden
 * so internals never reach a caller or a model.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const fields = [...new Set(err.issues.map((i) => i.path.join('.')).filter(Boolean))];
    const first = err.issues[0];
    const message = first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input';
    return new ApiError('validation_failed', message, { fields });
  }
  if (err instanceof AppError) {
    const legacy = (err as AppError & { code?: unknown }).code;
    const code = isApiErrorCode(legacy) ? legacy : codeForStatus(err.statusCode);
    return new ApiError(code, code === 'internal_error' ? 'Something went wrong on our side' : err.message);
  }
  return new ApiError('internal_error', 'Something went wrong on our side');
}

export function apiErrorBody(err: unknown, requestId: string | null): ApiErrorBody {
  const e = toApiError(err);
  return {
    status: 'error',
    code: e.code,
    message: e.message,
    hint: e.hint,
    fields: e.fields,
    retryable: e.retryable,
    requestId,
    ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
    ...(e.details ? { details: e.details } : {}),
  };
}

/** MCP tool result for a failed call: isError plus the same body as structured content. */
export function mcpErrorResult(err: unknown, requestId: string | null) {
  const body = apiErrorBody(err, requestId);
  const text = body.hint ? `${body.code}: ${body.message} ${body.hint}` : `${body.code}: ${body.message}`;
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text }],
    structuredContent: body as unknown as Record<string, unknown>,
  };
}

// ─── Request IDs ───

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** Every response carries X-Request-Id; a caller's own ID is kept when it looks sane. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
