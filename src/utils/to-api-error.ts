import { AppError } from './errors.js';
import { ApiError } from './api-error.js';

/** Older service code throws plain AppErrors; the spec wants coded errors with a next step. */
export function toApiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof AppError) {
    const m = err.message;
    if (err.statusCode === 404) throw new ApiError('not_found', m);
    if (err.statusCode === 409) throw new ApiError('duplicate', m);
    if (err.statusCode === 413) throw new ApiError('file_too_large', m);
    if (err.statusCode === 502) throw new ApiError('internal_error', m, { retryable: true, hint: 'Nothing was saved. Try again in a few minutes.' });
    throw new ApiError('validation_failed', m);
  }
  throw err;
}
