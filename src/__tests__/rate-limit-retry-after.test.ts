import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { rateLimitedHandler } from '../middleware/rate-limit.middleware.js';
import { requestId } from '../middleware/request-id.middleware.js';

// MCP spec v1.0 §3 and acceptance test 12: 130 calls in one minute give
// rate_limited with retryAfter after 120.
const tag = `${Date.now() % 1e9}`;
const ACCEPT = 'application/json, text/event-stream';
let owner = '';
const keyIds: string[] = [];

async function makeKey(scopes: string[]) {
  const res = await request(app).post('/api/v1/api-keys').set('Authorization', `Bearer ${owner}`).send({ name: `Hari Test 429 ${tag}`, scopes });
  expect(res.status).toBe(201);
  keyIds.push(res.body.data.apiKey.id);
  return { key: res.body.data.key as string, id: res.body.data.apiKey.id as string };
}

beforeAll(async () => {
  owner = (await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' })).body.data.tokens.accessToken;
});
afterAll(async () => {
  if (keyIds.length) {
    await db.delete(apiAuditLog).where(inArray(apiAuditLog.apiKeyId, keyIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  }
});

describe('429 in the shared error shape', () => {
  it('REST: call 121 in a minute is rate_limited with retryAfter and a Retry-After header (test 12)', async () => {
    const { key } = await makeKey(['clients:read']);
    const call = () => request(app).get('/api/v1/clients/lookup').query({ platform: 'meta', accountId: '1' }).set('X-API-Key', key);
    for (let i = 0; i < 120; i++) expect((await call()).status).not.toBe(429);
    const res = await call().set('X-Request-Id', `rl-${tag}`);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ status: 'error', code: 'rate_limited', retryable: true, requestId: `rl-${tag}` });
    expect(res.body.message).toContain('120 requests a minute');
    expect(res.body.hint).toContain('retryAfter');
    expect(res.body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(res.body.retryAfter).toBeLessThanOrEqual(60);
    expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfter);
  });

  it('MCP: the 429 is a JSON-RPC error carrying the same body', async () => {
    const { key, id } = await makeKey(['clients:read']);
    const rpc = () => request(app).post('/mcp').set('Authorization', `Bearer ${key}`).set('Accept', ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (let i = 0; i < 120; i++) expect((await rpc()).status).toBe(200);
    const res = await rpc();
    expect(res.status).toBe(429);
    // The request's own id, so the MCP client can match the error to its call.
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32000, data: { code: 'rate_limited', retryable: true } } });
    expect(res.body.error.data.retryAfter).toBe(Number(res.headers['retry-after']));
    // The refused call is still audited, as rate_limited.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await db.select().from(apiAuditLog).where(eq(apiAuditLog.apiKeyId, id));
    expect(rows.filter((r) => r.errorCode === 'rate_limited')).toHaveLength(1);
  });

  it('retryAfter counts down to the end of the window', async () => {
    const mini = express();
    mini.use(requestId);
    mini.use(rateLimit({ windowMs: 10_000, max: 1, standardHeaders: true, legacyHeaders: false, handler: rateLimitedHandler('Slow down', 'Wait.') }));
    mini.get('/', (_req, res) => { res.json({ ok: true }); });
    expect((await request(mini).get('/')).status).toBe(200);
    const limited = await request(mini).get('/');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited', message: 'Slow down', hint: 'Wait.', retryable: true });
    expect(limited.body.retryAfter).toBeGreaterThanOrEqual(9);
    expect(limited.body.retryAfter).toBeLessThanOrEqual(10);
    expect(limited.body.requestId).toBe(limited.headers['x-request-id']);
  });
});
