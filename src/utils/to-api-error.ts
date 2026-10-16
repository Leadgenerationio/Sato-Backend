import { AppError, MediaSourceError } from './errors.js';
import { ApiError } from './api-error.js';

/** Older service code throws plain AppErrors; the spec wants coded errors with a next step. The one mapper for every MCP tool. */
export function toApiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof AppError) {
    const m = err.message;
    if (err instanceof MediaSourceError && err.reason === 'file_too_large') {
      throw new ApiError('file_too_large', m, { hint: 'Images are up to 30 MB — resize it, or send a video (up to 50 MB this way, larger via create_upload).' });
    }
    if (err instanceof MediaSourceError && err.reason === 'unsupported_type') {
      throw new ApiError('unsupported_type', m, { hint: 'Send a jpg, png, webp or gif image, or an mp4 or mov video.' });
    }
    if (err instanceof MediaSourceError && err.reason === 'source_unreachable') {
      // A blocked or malformed address can never work, so it says retryable: false; a source that is down or busy keeps the default (true).
      throw new ApiError('source_unreachable', m, {
        retryable: err.retryable,
        hint: err.hint ?? (err.retryable === false
          ? 'This address can never be used: sourceUrl must be a public http(s) address that serves the file. Private and internal addresses are blocked. Send a different URL.'
          : 'The source could not be reached right now. Check that sourceUrl is a public http(s) address that serves the file, then try again.'),
      });
    }
    if (err.statusCode === 401) throw new ApiError('unauthorized', m);
    if (err.statusCode === 403) throw new ApiError('insufficient_scope', m);
    if (err.statusCode === 404) throw new ApiError('not_found', m);
    if (err.statusCode === 409) throw new ApiError('duplicate', m);
    if (err.statusCode === 413) throw new ApiError('file_too_large', m, { hint: 'This call takes files up to 50 MB. Larger files need create_upload and complete_upload.' });
    if (err.statusCode === 502) throw new ApiError('internal_error', m, { retryable: true, hint: 'Nothing was saved. Try again in a few minutes.' });
    if (err.statusCode >= 500) throw new ApiError('internal_error', m);
    throw new ApiError('validation_failed', m);
  }
  throw err;
}
