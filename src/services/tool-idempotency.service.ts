import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';
import { ApiError } from '../utils/api-error.js';

// MCP spec v1.0 section 3, Idempotency: every write tool takes an optional
// idempotencyKey. The first successful result for (key, caller) is kept 24 h and
// replayed for a retry with the same request; the same key with a different
// request is refused. Uses the same table as the REST Idempotency-Key header.

const TTL_MS = 24 * 60 * 60 * 1000;
const inFlight = new Set<string>();

export async function withIdempotency<T extends Record<string, unknown>>(
  keyId: string,
  idempotencyKey: string | undefined,
  tool: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  if (!idempotencyKey) return { value: await run(), replayed: false };
  const key = idempotencyKey.trim();
  if (key.length > 100) {
    throw new ApiError('validation_failed', 'idempotencyKey must be at most 100 characters.', { fields: [{ field: 'idempotencyKey', message: 'Too long' }] });
  }
  const owner = `key:${keyId}`;
  const requestHash = createHash('sha256').update(`tool ${tool}\n${JSON.stringify(request ?? null)}`).digest('hex');
  const since = new Date(Date.now() - TTL_MS);
  const [hit] = await db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.owner, owner), eq(idempotencyKeys.key, key), gt(idempotencyKeys.createdAt, since)));
  if (hit) {
    if (hit.requestHash !== requestHash) {
      throw new ApiError('validation_failed', 'This idempotencyKey was already used with a different request.', {
        fields: [{ field: 'idempotencyKey', message: 'Already used with different arguments' }],
        hint: 'Use a new idempotencyKey for a different request, or repeat the original request exactly to get the same result.',
      });
    }
    return { value: hit.response as T, replayed: true };
  }
  const flight = `${owner}|${key}`;
  if (inFlight.has(flight)) {
    throw new ApiError('validation_failed', 'A request with this idempotencyKey is still being processed.', { retryable: true, hint: 'Retry in a few seconds.' });
  }
  inFlight.add(flight);
  try {
    const value = await run();
    // Only successes are kept: a failed call must be retryable once the caller fixes it.
    await db.insert(idempotencyKeys).values({ owner, key, requestHash, status: 200, response: value })
      .onConflictDoUpdate({ target: [idempotencyKeys.owner, idempotencyKeys.key], set: { requestHash, status: 200, response: value, createdAt: new Date() } });
    return { value, replayed: false };
  } finally {
    inFlight.delete(flight);
  }
}
