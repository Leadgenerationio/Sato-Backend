import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';
import { withIdempotency } from '../services/tool-idempotency.service.js';
import { fetchRemoteMedia } from '../utils/remote-media.js';
import { MediaSourceError } from '../utils/errors.js';

// Review of #78: the MCP idempotencyKey and REST's Idempotency-Key header share
// a table, so they need their own namespaces; an in-flight key is not invalid
// input; media errors carry a reason instead of being matched by message.
const keyId = randomUUID();
afterAll(async () => {
  await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.owner, [`key:${keyId}`, `mcp:key:${keyId}`]));
});

describe('withIdempotency', () => {
  it('a REST Idempotency-Key with the same value does not collide with the tool key', async () => {
    // What the REST middleware writes for header `Idempotency-Key: shared-1`.
    await db.insert(idempotencyKeys).values({ owner: `key:${keyId}`, key: 'shared-1', requestHash: 'f'.repeat(64), status: 201, response: { rest: true } });
    const first = await withIdempotency(keyId, 'shared-1', 'upload_asset', { a: 1 }, async () => ({ n: 1 }));
    expect(first).toEqual({ value: { n: 1 }, replayed: false });
    const again = await withIdempotency(keyId, 'shared-1', 'upload_asset', { a: 1 }, async () => ({ n: 2 }));
    expect(again).toEqual({ value: { n: 1 }, replayed: true });
  });

  it('a call still running with the same key is rate_limited and retryable, not validation_failed', async () => {
    let release!: () => void;
    const slow = withIdempotency(keyId, 'inflight-1', 'upload_asset', { a: 1 }, () => new Promise((r) => { release = () => r({ ok: true }); }));
    await new Promise((r) => setImmediate(r));
    await expect(withIdempotency(keyId, 'inflight-1', 'upload_asset', { a: 1 }, async () => ({ ok: false })))
      .rejects.toMatchObject({ code: 'rate_limited', retryable: true, details: { reason: 'idempotency_key_in_progress' } });
    release();
    await slow;
  });
});

describe('remote media errors carry a reason', () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const fetchAs = (status: number, type: string) => (async () => new Response(new Uint8Array(1), { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
  it.each([
    ['not a URL', 'nope', fetchAs(200, 'image/png'), 'source_unreachable'],
    ['a private address', 'https://internal.example.com/a.png', fetchAs(200, 'image/png'), 'source_unreachable'],
    ['a 404', 'https://cdn.example.com/a.png', fetchAs(404, 'text/html'), 'source_unreachable'],
    ['an .exe', 'https://cdn.example.com/a.exe', fetchAs(200, 'application/x-msdownload'), 'unsupported_type'],
  ] as const)('%s', async (_name, u, fetchImpl, reason) => {
    const lookup = u.includes('internal') ? async () => [{ address: '10.0.0.1' }] : publicLookup;
    const err = await fetchRemoteMedia(u, { lookup, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaSourceError);
    expect(err).toMatchObject({ statusCode: 422, reason });
  });
});
