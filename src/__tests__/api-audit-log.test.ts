import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog, type ApiAuditRow } from '../db/schema/api-audit-log.js';
import { revokeApiKey } from '../services/api-key.service.js';
import { redact, auditJson, writeAuditRow, auditOnFinish, REDACTED } from '../services/api-audit.service.js';
import { EventEmitter } from 'node:events';
import { apiKeyOrJwt, idempotency } from '../middleware/api-key.middleware.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';

// MCP spec v1.0 §3 audit log (step 1g): one row per API-key call, REST and
// MCP, with key, owner, bot name, tool, redacted arguments, result and error
// code. Feeds spec tests 5, 10 and 16.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = '';
const keyIds: string[] = [];

async function makeKey(scopes: string[]): Promise<{ key: string; id: string }> {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Hari Test audit ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key, id: res.body.data.apiKey.id };
}

/** The row is written after the response; wait for it. */
async function auditRowsFor(keyId: string, n = 1, timeoutMs = 3000): Promise<ApiAuditRow[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.select().from(apiAuditLog).where(eq(apiAuditLog.apiKeyId, keyId)).orderBy(desc(apiAuditLog.id));
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  owner = login.body.data.tokens.accessToken;
});
afterAll(async () => {
  if (keyIds.length) {
    await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  }
});

describe('redaction', () => {
  it('masks secret fields, Stato keys and signed URL parameters', () => {
    const out = redact({
      name: 'Hearing CH',
      password: 'hunter2',
      nested: { apiKey: 'abc', Authorization: 'Bearer x', refresh_token: 'r' },
      echoedKey: 'stk_abcdefghijklmnop',
      sourceUrl: 'https://bucket.r2.example.com/v.mp4?X-Amz-Signature=deadbeef&X-Amz-Credential=me&width=640',
      list: [{ secret: 's' }],
    }) as Record<string, any>;
    expect(out.name).toBe('Hearing CH');
    expect(out.password).toBe(REDACTED);
    expect(out.nested).toEqual({ apiKey: REDACTED, Authorization: REDACTED, refresh_token: REDACTED });
    expect(out.echoedKey).toBe(REDACTED);
    expect(out.sourceUrl).not.toContain('deadbeef');
    expect(out.sourceUrl).not.toContain('Credential=me');
    expect(out.sourceUrl).toContain('width=640');
    expect(out.list).toEqual([{ secret: REDACTED }]);
  });

  it('masks the password in user:pass@host URLs and secret-looking query parameters, and keeps the harmless ones', () => {
    const out = redact({
      a: 'https://alice:s3cr3tpw@files.example.com/video.mp4',
      b: 'https://files.example.com/v.mp4?password=hunter2&refresh_token=rt-123&secret=abc&client_secret=cs&width=640&utm_campaign=ch',
      c: 'https://bob@files.example.com/v.mp4?x=1',
    }) as Record<string, string>;
    expect(out.a).not.toContain('s3cr3tpw');
    expect(out.a).not.toContain('alice');
    expect(out.a).toContain('files.example.com/video.mp4');
    for (const secret of ['hunter2', 'rt-123', '=abc', 'cs&']) expect(out.b).not.toContain(secret);
    expect(out.b).toContain('width=640');
    expect(out.b).toContain('utm_campaign=ch');
    expect(out.c).not.toContain('bob');
    expect(out.c).toContain('x=1');
  });

  it('keeps the size of file bytes and long strings, not their content', () => {
    const base64 = 'A'.repeat(50_000);
    expect(redact(base64)).toBe('[50000 characters]');
    expect(redact(Buffer.alloc(1234))).toBe('[1234 bytes]');
  });

  it('cuts long lists and deep nesting, and caps a column at 16 KB', () => {
    const list = redact(Array.from({ length: 60 }, (_, i) => i)) as unknown[];
    expect(list).toHaveLength(51);
    expect(list[50]).toBe('[10 more]');
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain('[nested]');
    const big = auditJson(Array.from({ length: 40 }, () => 'x'.repeat(1900))) as Record<string, unknown>;
    expect(big).toMatchObject({ truncated: true });
  });

  it('masks a Stato key inside a longer string, and other providers\' signed-URL parameters', () => {
    const k = `stk_${'A'.repeat(43)}`;
    expect(redact(`Bearer ${k}`)).toBe(`Bearer ${REDACTED}`);
    expect(redact(`note: the key is ${k}, keep it safe`)).toBe(`note: the key is ${REDACTED}, keep it safe`);
    const out = redact('https://storage.googleapis.com/b/o.png?X-Goog-Signature=abc&X-Goog-Credential=def&w=1') as string;
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
    expect(out).toContain('w=1');
    for (const p of ['apikey', 'api_key', 'auth', 'jwt']) expect(redact(`https://x.example.com/a?${p}=s3cret`)).not.toContain('s3cret');
  });
});

describe('a client that disconnects before the answer', () => {
  it('still gets one row, marked client_closed', async () => {
    const { id } = await makeKey(['clients:read']);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    const res = Object.assign(new EventEmitter(), { locals: {} as Record<string, unknown>, statusCode: 200, writableFinished: false, json: () => res });
    const req = { originalUrl: '/api/v1/creatives', method: 'POST', body: {}, query: {}, ip: '1.2.3.4', get: () => undefined };
    auditOnFinish(k!, req as never, res as never);
    res.emit('close');
    res.emit('close');
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ errorCode: 'client_closed', result: { outcome: 'error', code: 'client_closed' } });
  });
});

describe('one row per key call', () => {
  it('REST: path, method, status, redacted query and the error code from the body', async () => {
    const { key, id } = await makeKey(['clients:read']);
    const res = await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: `9${tag}`, token: 'leak-me' })
      .set('X-API-Key', key).set('X-Stato-Agent', 'Grok Bot').set('X-Request-Id', `audit-${tag}`);
    expect(res.status).toBe(404);
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({
      businessId: BIZ, apiKeyId: id, keyName: `Hari Test audit ${tag}`, agent: 'Grok Bot', transport: 'rest',
      method: 'GET', path: '/api/v1/clients/lookup', status: 404, errorCode: 'not_found', requestId: `audit-${tag}`,
      result: { outcome: 'error', code: 'not_found' }, tool: null,
    });
    expect(row!.args).toMatchObject({ query: { platform: 'meta', accountId: `9${tag}`, token: REDACTED } });
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('REST: a missing scope is logged as insufficient_scope', async () => {
    const { key, id } = await makeKey(['creatives:read']);
    const res = await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: '1' }).set('X-API-Key', key);
    expect(res.status).toBe(403);
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({ status: 403, errorCode: 'insufficient_scope' });
  });

  it('MCP: tool name, arguments, agent and an ok result', async () => {
    const { key, id } = await makeKey(['clients:read']);
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).set('X-Stato-Agent', 'Cursor bot')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    expect(res.status).toBe(200);
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({ transport: 'mcp', tool: 'whoami', agent: 'Cursor bot', method: 'POST', path: '/mcp', status: 200, errorCode: null, result: { outcome: 'ok' } });
  });

  it('MCP: a call to an unknown tool is still one row, named after the tool', async () => {
    const { key, id } = await makeKey(['clients:read']);
    await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: { password: 'p' } } });
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(1);
    // The tool never ran: logged as not_found, not as a success.
    expect(rows[0]).toMatchObject({ transport: 'mcp', tool: 'no_such_tool', errorCode: 'not_found', result: { outcome: 'error', code: 'not_found' } });
    expect(rows[0]!.args).toMatchObject({ method: 'tools/call', arguments: { password: REDACTED } });
  });

  it('MCP: a known tool the SDK refuses before it runs is validation_failed', async () => {
    const { key, id } = await makeKey(['clients:read']);
    await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: 'not an object' } });
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({ tool: 'whoami', errorCode: 'validation_failed' });
  });

  it('MCP: tools/list is logged too, with no tool name', async () => {
    const { key, id } = await makeKey(['clients:read']);
    await request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({ transport: 'mcp', tool: null, args: { method: 'tools/list' }, errorCode: null });
  });

  it('a revoked key is refused and the attempt is logged against it (spec test 10)', async () => {
    const { key, id } = await makeKey(['clients:read']);
    await revokeApiKey(BIZ, id);
    const res = await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: '1' }).set('X-API-Key', key);
    expect(res.status).toBe(401);
    const [row] = await auditRowsFor(id);
    expect(row).toMatchObject({ apiKeyId: id, status: 401, errorCode: 'unauthorized', result: { outcome: 'error', code: 'unauthorized' } });
  });

  it('a key Stato never issued writes no row', async () => {
    const before = await db.select({ id: apiAuditLog.id }).from(apiAuditLog).where(and(eq(apiAuditLog.businessId, BIZ), eq(apiAuditLog.path, '/api/v1/clients/lookup')));
    const res = await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: '1' }).set('X-API-Key', `stk_never_issued_${tag}`);
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    const after = await db.select({ id: apiAuditLog.id }).from(apiAuditLog).where(and(eq(apiAuditLog.businessId, BIZ), eq(apiAuditLog.path, '/api/v1/clients/lookup')));
    expect(after.length).toBe(before.length);
  });

  it('a signed-in user (no key) writes no audit row', async () => {
    const before = await db.select({ id: apiAuditLog.id }).from(apiAuditLog);
    await request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: '1' }).set('Authorization', `Bearer ${owner}`);
    await new Promise((r) => setTimeout(r, 200));
    const after = await db.select({ id: apiAuditLog.id }).from(apiAuditLog);
    expect(after.length).toBe(before.length);
  });

  it('Idempotency-Key still replays with the audit hook in place, and both calls are logged', async () => {
    // The hook wraps res.json, as the idempotency middleware does; both must keep working.
    const { key, id } = await makeKey(['creatives:write']);
    let runs = 0;
    const mini = express();
    mini.use(express.json());
    mini.post('/thing', apiKeyOrJwt, idempotency, (_req, res) => { runs += 1; res.status(201).json({ status: 'success', data: { n: runs } }); });
    const k = `audit-idem-${tag}`;
    const first = await request(mini).post('/thing').set('X-API-Key', key).set('Idempotency-Key', k).send({ a: 1 });
    await new Promise((r) => setTimeout(r, 100)); // the stored response is written before the reply
    const retry = await request(mini).post('/thing').set('X-API-Key', key).set('Idempotency-Key', k).send({ a: 1 });
    const other = await request(mini).post('/thing').set('X-API-Key', key).set('Idempotency-Key', k).send({ a: 2 });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.n).toBe(1);
    expect(runs).toBe(1);
    expect(other.status).toBe(422);
    const rows = await auditRowsFor(id, 3);
    expect(rows.map((r) => r.status).sort()).toEqual([201, 201, 422]);
    expect(rows.find((r) => r.status === 422)!.errorCode).toBe('idempotency_key_reused');
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, k));
  });

  it('a failed audit write never fails the call', async () => {
    const spy = vi.spyOn(db, 'insert').mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(writeAuditRow({ businessId: BIZ, transport: 'rest' })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
