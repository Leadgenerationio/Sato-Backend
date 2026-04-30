import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;
let realClientId: string; // UUID of an existing DB client — used in detail / update / credit tests
let realCompanyName: string; // Company name of that client — used in search test
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Client API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Create a dedicated client for ID-specific tests (detail / update /
    // credit). Must have a companyNumber so runCreditCheck works — the
    // Endole provider needs it. Self-contained so we don't depend on
    // pre-seeded DB state.
    const createRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Test Co ${Date.now()}`,
        companyNumber: '00445790',
        contactName: 'Test Contact',
        contactEmail: 'contact@test.co',
        currency: 'GBP',
      });
    realClientId = createRes.body.data.client.id;
    realCompanyName = createRes.body.data.client.companyName;
  });

  describe('GET /api/v1/clients', () => {
    it('owner can list clients', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
    });

    it('client role cannot list clients', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/v1/clients?status=active').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.clients.forEach((c: any) => expect(c.status).toBe('active'));
    });

    it('filters by search', async () => {
      const term = realCompanyName.split(' ')[0].toLowerCase();
      const res = await request(app).get(`/api/v1/clients?search=${encodeURIComponent(term)}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/clients/:id', () => {
    it('returns client detail', async () => {
      const res = await request(app).get(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.companyName).toBe(realCompanyName);
      expect(res.body.data.client.billingWorkflow).toBeDefined();
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).get(`/api/v1/clients/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/clients', () => {
    it('creates a new client', async () => {
      const res = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`).send({
        companyName: 'Test Corp',
        contactName: 'Test User',
        contactEmail: 'test@testcorp.com',
        currency: 'GBP',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.client.companyName).toBe('Test Corp');
      expect(res.body.data.client.status).toBe('prospect');
    });

    // Sam asked for credit checks to auto-trigger on buyer creation so staff
    // never forget. Fire-and-forget — the create response returns immediately,
    // the score lands within a few seconds via the credit-checks table.
    it('auto-triggers a credit check when companyNumber is provided', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `AutoCheck Co ${Date.now()}`,
          companyNumber: '00445790',
          contactName: 'Auto Check',
          contactEmail: 'auto@check.co',
          currency: 'GBP',
        });
      expect(createRes.status).toBe(201);
      const newId = createRes.body.data.client.id;

      // Poll up to 5s for the auto-triggered credit check to land.
      let history: unknown[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .get(`/api/v1/clients/${newId}/credit-history`)
          .set('Authorization', `Bearer ${ownerToken}`);
        history = res.body.data.history;
        if (history.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(history.length).toBeGreaterThan(0);
    });

    it('does NOT auto-trigger a credit check when companyNumber is missing', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `NoNumber Co ${Date.now()}`,
          contactName: 'No Number',
          contactEmail: 'no@number.co',
          currency: 'GBP',
        });
      expect(createRes.status).toBe(201);
      const newId = createRes.body.data.client.id;

      // Wait briefly to confirm nothing fires in background.
      await new Promise((r) => setTimeout(r, 800));
      const res = await request(app)
        .get(`/api/v1/clients/${newId}/credit-history`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.data.history).toHaveLength(0);
    });
  });

  describe('PUT /api/v1/clients/:id', () => {
    it('updates a client', async () => {
      const res = await request(app).put(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`).send({
        notes: 'Updated via test',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.client.notes).toBe('Updated via test');
    });
  });

  describe('GET /api/v1/clients/:id/credit-history', () => {
    it('returns credit history (may be empty before any check has run)', async () => {
      const res = await request(app).get(`/api/v1/clients/${realClientId}/credit-history`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.history)).toBe(true);
    });
  });

  describe('POST /api/v1/clients/:id/credit-check', () => {
    it('runs a credit check', async () => {
      const res = await request(app).post(`/api/v1/clients/${realClientId}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.creditCheck.creditScore).toBeDefined();
      expect(res.body.data.creditCheck.riskRating).toBeDefined();
    });

    it('persists endoleCompanyId on the client row after a successful check', async () => {
      // Run a check to ensure the column gets populated, then read the client
      // back. The External System IDs card on the client detail page reads
      // this column, so a regression here would make the card show
      // "Not linked" forever even after running checks (pre-fix behaviour).
      await request(app).post(`/api/v1/clients/${realClientId}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      const res = await request(app).get(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.endoleCompanyId).toBe('00445790');
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).post(`/api/v1/clients/${MISSING_UUID}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/clients/credit-alerts', () => {
    it('returns credit alerts', async () => {
      const res = await request(app).get('/api/v1/clients/credit-alerts').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.alerts).toBeDefined();
    });
  });
});
