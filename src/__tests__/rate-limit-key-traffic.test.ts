import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import realApp from '../index.js';
import { createGeneralLimiter, createKeyFailureLimiter, GENERAL_LIMIT_MAX, isApiKeyRequest } from '../middleware/rate-limit.middleware.js';

// MCP spec v1.0 section 3 promises 120 calls a minute per key. The per-IP limit (1,500 per 15 minutes, about 100 a
// minute) used to run first and stop a busy bot after about 12 minutes, so key traffic is now limited per key only,
// and the only per-IP limit it keeps is on calls refused for a wrong key.
const KEY = 'Bearer stk_abcdefghijklmnopqrstuvwxyz0123456789';

function appWith(general: number, failures: number) {
  const app = express();
  app.set('trust proxy', false);
  app.use(createGeneralLimiter(general));
  app.use(createKeyFailureLimiter(failures));
  app.post('/mcp', (_req, res) => { res.json({ ok: true }); });
  app.post('/other', (_req, res) => { res.json({ ok: true }); });
  app.post('/refused', (_req, res) => { res.status(401).json({ no: true }); });
  app.post('/missing', (_req, res) => { res.status(404).json({ no: true }); });
  return app;
}

describe('per-IP limit and API-key traffic', () => {
  it('knows a key request: X-API-Key or Bearer stk_, not a login token', () => {
    const get = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] }) as never;
    expect(isApiKeyRequest(get({ 'x-api-key': 'stk_x' }))).toBe(true);
    expect(isApiKeyRequest(get({ authorization: KEY }))).toBe(true);
    expect(isApiKeyRequest(get({ authorization: 'Bearer eyJhbGciOi.jwt.token' }))).toBe(false);
    expect(isApiKeyRequest(get({}))).toBe(false);
  });
  it('the real limit is the one the old 12-minute failure came from (about 100 a minute)', () => {
    expect(GENERAL_LIMIT_MAX / 15).toBeLessThan(120);
  });
  it('a bot sending more calls than the per-IP cap is not stopped by it; a portal user still is', async () => {
    const app = appWith(5, 100);
    for (let i = 0; i < 20; i++) expect((await request(app).post('/mcp').set('Authorization', KEY)).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await request(app).post('/mcp?x=1').set('X-API-Key', 'stk_abc')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await request(app).post('/other').set('Authorization', 'Bearer jwt.token.here')).status).toBe(200);
    const stopped = await request(app).post('/other').set('Authorization', 'Bearer jwt.token.here');
    expect(stopped.status).toBe(429);
    expect(stopped.body).toMatchObject({ code: 'rate_limited', retryable: true });
  });
  it('a junk key-shaped header does NOT lift the per-IP cap anywhere but /mcp (review of #117)', async () => {
    const app = appWith(4, 1000);
    for (let i = 0; i < 4; i++) expect((await request(app).post('/other').set('Authorization', KEY)).status).toBe(200);
    const blocked = await request(app).post('/other').set('X-API-Key', 'junk');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
  });
  it('wrong-key guessing is stopped per IP, but answers like not_found never count', async () => {
    const app = appWith(1000, 3);
    for (let i = 0; i < 50; i++) expect((await request(app).post('/missing').set('Authorization', KEY)).status).toBe(404);
    for (let i = 0; i < 50; i++) expect((await request(app).post('/mcp').set('Authorization', KEY)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await request(app).post('/refused').set('Authorization', KEY)).status).toBe(401);
    const guessing = await request(app).post('/refused').set('Authorization', KEY);
    expect(guessing.status).toBe(429);
    expect(guessing.body.code).toBe('rate_limited');
  });
});

describe('the real app', () => {
  it('counts a portal request against the per-IP cap, and a key request against the wrong-key cap instead', async () => {
    const portal = await request(realApp).get('/health');
    expect(portal.headers['ratelimit-policy']).toContain(`${GENERAL_LIMIT_MAX};w=900`);
    const bot = await request(realApp).post('/mcp').set('Authorization', 'Bearer stk_bogusbogusbogusbogusbogusbogus').set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(bot.status).toBe(401);
    expect(bot.headers['ratelimit-policy']).not.toContain(`${GENERAL_LIMIT_MAX};w=900`);
    expect(bot.headers['ratelimit-policy']).toContain('300;w=900');
  });
});
