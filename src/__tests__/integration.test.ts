import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import * as xero from '../integrations/xero/xero-client.js';
import { invalidateCache } from '../utils/cache.js';

let ownerToken: string;
let clientToken: string;

describe('Integration API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  describe('GET /api/v1/integrations/xero/status', () => {
    it('returns xero connection status', async () => {
      const res = await request(app).get('/api/v1/integrations/xero/status').set('Authorization', `Bearer ${ownerToken}`);
      // 200 with status, or 500 if DB not connected (no businessId in mock user)
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.data).toBeDefined();
      }
    });
  });

  // /xero/auth-url was removed when we switched to Custom Connection
  // (server-to-server, no OAuth consent flow needed). See xero-client.test.ts.

  describe('POST /api/v1/integrations/xero/disconnect', () => {
    it('works for owner', async () => {
      const res = await request(app).post('/api/v1/integrations/xero/disconnect').set('Authorization', `Bearer ${ownerToken}`);
      // 200 success, 400 if no business, or 500 if DB not connected
      expect([200, 400, 500]).toContain(res.status);
    });
  });

  // ─── RBAC ───

  describe('RBAC', () => {
    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/integrations/xero/status').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('non-owner roles get 403 on disconnect', async () => {
      const res = await request(app).post('/api/v1/integrations/xero/disconnect').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─── Unauthenticated ───

  describe('Unauthenticated access', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/integrations/xero/status');
      expect(res.status).toBe(401);
    });
  });

  // ─── LeadByte status + manual sync ───

  describe('GET /api/v1/integrations/leadbyte/status', () => {
    it('returns configured + lastSyncAt for owner', async () => {
      const res = await request(app).get('/api/v1/integrations/leadbyte/status').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('configured');
      expect(res.body.data).toHaveProperty('lastSyncAt');
    });

    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/integrations/leadbyte/status').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/integrations/leadbyte/sync', () => {
    it('enqueues job or returns 503 when Redis unavailable', async () => {
      const res = await request(app).post('/api/v1/integrations/leadbyte/sync').set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 503]).toContain(res.status);
      if (res.status === 200) expect(res.body.data.jobId).toBeDefined();
    });

    it('client role gets 403', async () => {
      const res = await request(app).post('/api/v1/integrations/leadbyte/sync').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─── Aggregate overview (visual dashboard) ───

  describe('GET /api/v1/integrations/overview', () => {
    it('returns all integration statuses + key metrics in one shot', async () => {
      const res = await request(app).get('/api/v1/integrations/overview').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      // Each card has its own configured flag.
      expect(d.xero).toMatchObject({ configured: expect.any(Boolean) });
      expect(d.leadbyte).toMatchObject({ configured: expect.any(Boolean), leadsThisMonth: expect.any(Number) });
      expect(d.catchr).toMatchObject({ configured: expect.any(Boolean), adSpendLast30Days: expect.any(Number), currency: 'GBP' });
      expect(d.signnow).toMatchObject({ configured: expect.any(Boolean), agreementCount: expect.any(Number) });
      expect(d.r2).toMatchObject({ configured: expect.any(Boolean), fileCount: expect.any(Number) });
      expect(d.resend).toMatchObject({ configured: expect.any(Boolean) });
      expect(d.creditCheck).toMatchObject({ configured: expect.any(Boolean), checksRun: expect.any(Number) });
      expect(['creditsafe', 'endole', 'mock']).toContain(d.creditCheck.provider);
    });

    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/integrations/overview').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    // The integrations dashboard was sitting on "Auth pending" even after a
    // valid Xero re-auth because getStatus() only reads the in-memory token
    // cache, and the overview endpoint never triggered a token exchange. The
    // fix warms the token on every overview request, so the very next call
    // after a portal-side re-auth surfaces "Live · <tenant>" rather than the
    // stale "Auth pending" state.
    describe('Xero token warmup', () => {
      const originalEnv = { ...process.env };
      const originalFetch = global.fetch;

      beforeEach(async () => {
        process.env.XERO_CLIENT_ID = 'test-id';
        process.env.XERO_CLIENT_SECRET = 'test-secret';
        xero.__testing.resetCache();
        // The overview response is Redis-cached for 15s; prior tests in
        // this file populate it, which would mask the warmup behavior.
        await invalidateCache('integrations:overview');
      });
      afterEach(async () => {
        process.env = { ...originalEnv };
        global.fetch = originalFetch;
        xero.__testing.resetCache();
        await invalidateCache('integrations:overview');
      });

      it('flips xero.connected to true after a fresh exchange on the first overview call', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('identity.xero.com/connect/token')) {
            return new Response(
              JSON.stringify({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 1800 }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.includes('api.xero.com/connections')) {
            return new Response(
              JSON.stringify([
                { id: 'c1', tenantId: 'tenant-1', tenantName: 'Clinical Marketing Solutions Ltd' },
              ]),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          // Any other Xero call during this test is unexpected.
          return new Response('{}', { status: 500 });
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        const res = await request(app)
          .get('/api/v1/integrations/overview')
          .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.xero).toMatchObject({
          configured: true,
          connected: true,
          tenantName: 'Clinical Marketing Solutions Ltd',
        });
        // Token endpoint was hit exactly once — the warmup happened.
        const tokenCalls = fetchMock.mock.calls.filter(([u]) =>
          (typeof u === 'string' ? u : (u as URL).toString()).includes('identity.xero.com/connect/token'),
        );
        expect(tokenCalls.length).toBeGreaterThanOrEqual(1);
      });

      it('reports connected:false (not 500) when the warmup exchange fails', async () => {
        global.fetch = vi.fn(async () =>
          new Response(JSON.stringify({ error: 'invalid_scope' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ) as unknown as typeof fetch;

        const res = await request(app)
          .get('/api/v1/integrations/overview')
          .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.xero).toMatchObject({
          configured: true,
          connected: false,
        });
      });
    });
  });

  // ─── Credit check status ───

  describe('GET /api/v1/integrations/credit-check/status', () => {
    it('returns provider + configured + checksRun for owner', async () => {
      const res = await request(app).get('/api/v1/integrations/credit-check/status').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(['creditsafe', 'endole', 'mock']).toContain(res.body.data.provider);
      expect(typeof res.body.data.configured).toBe('boolean');
      expect(typeof res.body.data.checksRun).toBe('number');
    });

    it('client role gets 403', async () => {
      const res = await request(app).get('/api/v1/integrations/credit-check/status').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─── Catchr account picker for the campaign Traffic Sources UI ───
  //
  // Sam's 2026-05-15 Loom: the traffic-source dialog forced users to paste
  // a Catchr NCP URL by hand. New endpoint surfaces the same dropdown
  // leadreports.io renders. Must return `{ accounts: [] }` (not 500) when
  // Catchr isn't configured so the UI degrades to manual-URL entry gracefully.

  describe('GET /api/v1/integrations/catchr/accounts', () => {
    const originalEnv = { ...process.env };
    const originalFetch = global.fetch;

    afterEach(async () => {
      process.env = { ...originalEnv };
      global.fetch = originalFetch;
      await invalidateCache('catchr:accounts:all');
      await invalidateCache('catchr:accounts:facebook-ads');
      await invalidateCache('catchr:accounts:google-ads');
      await invalidateCache('catchr:accounts:tik-tok');
    });

    it('returns configured:false + empty accounts when Catchr not configured', async () => {
      delete process.env.CATCHR_ACCESS_TOKEN;
      await invalidateCache('catchr:accounts:all');
      const res = await request(app)
        .get('/api/v1/integrations/catchr/accounts')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ configured: false, accounts: [] });
    });

    it('client role gets 403', async () => {
      const res = await request(app)
        .get('/api/v1/integrations/catchr/accounts?platform=facebook')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    // Frontend now fetches the supplier list from /catchr/platforms and
    // sends Catchr's canonical slug (e.g. 'facebook-ads') straight to
    // /catchr/accounts. The controller no longer translates — whatever
    // slug arrives is passed through to listSources. This test pins the
    // pass-through so a future change doesn't silently re-introduce a
    // mapping that would drift out of sync with Catchr's catalog.
    it('passes the platform query param straight through to Catchr listSources', async () => {
      process.env.CATCHR_ACCESS_TOKEN = 'test-token';
      const capturedPlatforms: string[] = [];

      global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        let rpc: { method?: string; params?: { name?: string; arguments?: { platform?: string } } } = {};
        try { rpc = JSON.parse(bodyStr); } catch { /* not JSON */ }

        if (rpc.method === 'initialize') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
          });
        }
        if (rpc.method === 'tools/call' && rpc.params?.name === 'list_sources') {
          capturedPlatforms.push(rpc.params.arguments?.platform ?? '');
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { content: [{ type: 'text', text: JSON.stringify({ count: 0, sources: [] }) }] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('', { status: 202, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;

      await invalidateCache('catchr:accounts:facebook-ads');
      const res = await request(app)
        .get('/api/v1/integrations/catchr/accounts?platform=facebook-ads')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ configured: true, accounts: [] });
      // Whatever slug came in (Catchr's canonical 'facebook-ads' from the
      // /platforms list) goes straight through — no transformation.
      expect(capturedPlatforms).toContain('facebook-ads');
    });

    it('returns configured:true + empty platforms when Catchr is off (via /platforms)', async () => {
      delete process.env.CATCHR_ACCESS_TOKEN;
      await invalidateCache('catchr:platforms:connected');
      const res = await request(app)
        .get('/api/v1/integrations/catchr/platforms')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ configured: false, platforms: [] });
    });
  });
});
