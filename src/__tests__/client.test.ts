import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;

describe('Client API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
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
      const res = await request(app).get('/api/v1/clients?search=apex').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/clients/:id', () => {
    it('returns client detail', async () => {
      const res = await request(app).get('/api/v1/clients/c-1').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.companyName).toBe('Apex Media Ltd');
      expect(res.body.data.client.creditScore).toBeDefined();
      expect(res.body.data.client.billingWorkflow).toBeDefined();
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).get('/api/v1/clients/c-999').set('Authorization', `Bearer ${ownerToken}`);
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
  });

  describe('PUT /api/v1/clients/:id', () => {
    it('updates a client', async () => {
      const res = await request(app).put('/api/v1/clients/c-1').set('Authorization', `Bearer ${ownerToken}`).send({
        notes: 'Updated via test',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.client.notes).toBe('Updated via test');
    });
  });

  describe('GET /api/v1/clients/:id/credit-history', () => {
    it('returns credit history', async () => {
      const res = await request(app).get('/api/v1/clients/c-1/credit-history').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.history.length).toBeGreaterThan(0);
      expect(res.body.data.history[0].creditScore).toBeDefined();
      expect(res.body.data.history[0].riskRating).toBeDefined();
    });
  });

  describe('POST /api/v1/clients/:id/credit-check', () => {
    it('runs a credit check', async () => {
      const res = await request(app).post('/api/v1/clients/c-1/credit-check').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.creditCheck.creditScore).toBeDefined();
      expect(res.body.data.creditCheck.riskRating).toBeDefined();
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).post('/api/v1/clients/c-999/credit-check').set('Authorization', `Bearer ${ownerToken}`);
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
