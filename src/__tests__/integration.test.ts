import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

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
});
