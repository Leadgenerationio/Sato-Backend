import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';
import { ApiError } from '../utils/api-error.js';

// MCP spec v1.0 section 3, Idempotency: every write tool takes an optional
// idempotencyKey. The first successful result for (key, caller) is kept 24 h and
// replayed for a retry with the same request; the same key with a different
// request is refused. Uses the same table as the REST Idempotency-Key header,
// so MCP rows have their own owner (`mcp:key:<id>`, REST uses `key:<id>`): a bot
// that uses one counter for both never collides with itself. The tool name is in
// the request hash, so one key reused across tools is refused like any reuse.

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
  const owner = `mcp:key:${keyId}`;
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
    // Not invalid input: the first call with this key has not finished yet. The
    // spec has no conflict code, so this is rate_limited, the code a bot already
    // answers by waiting and repeating the same call unchanged.
    throw new ApiError('rate_limited', `The earlier ${tool} call with idempotencyKey "${key}" is still running.`, {
      retryable: true,
      hint: `Wait a few seconds, then repeat the same call with the same arguments and idempotencyKey to get its result. Do not change the arguments.`,
      details: { retryAfter: 2, reason: 'idempotency_key_in_progress' },
    });
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

/**
 * withIdempotency for the tools that answer { summary, data, audit }: the first answer is kept and a retry with the
 * same idempotencyKey and arguments gets it back, with the summary saying so.
 */
export async function withToolResult<R extends { summary: string; data: unknown; audit?: unknown }>(
  keyId: string,
  idempotencyKey: string | undefined,
  tool: string,
  request: unknown,
  run: () => Promise<R>,
): Promise<R> {
  const { value, replayed } = await withIdempotency(keyId, idempotencyKey, tool, request, async () => (await run()) as unknown as Record<string, unknown>);
  const r = value as unknown as R;
  return replayed ? { ...r, summary: `Same request as before (idempotencyKey): returning the first answer. ${r.summary}` } : r;
}
