import { ApiError } from './api-error.js';

// One opaque base64url-JSON cursor codec for every paged MCP list (list_clients, list_campaigns, list_assets,
// list_ad_accounts). The payload is never trusted: decode takes a validator that returns the typed cursor or null, and
// any malformed/garbage/legacy cursor becomes a single clean validation_failed — so the length cap and error live in
// one place instead of three hand-rolled copies.

/** The error for a cursor that isn't the unchanged nextCursor from a previous page. */
export const invalidCursor = (): ApiError =>
  new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] });

export const encodeCursor = (payload: unknown): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

export function decodeCursor<T>(cursor: string | undefined, validate: (v: unknown) => T | null): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const valid = validate(parsed);
    if (valid !== null) return valid;
  } catch { /* fall through to the single throw below */ }
  throw invalidCursor();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Max accepted cursor length for the list tools' input schema. A keyset cursor can embed a 255-char name plus a UUID,
// which base64url-encodes to ~410 chars — comfortably under this. Must stay above that, or paging past a long-named
// row produces a nextCursor the tool's own input then rejects.
export const CURSOR_MAX_LEN = 512;

