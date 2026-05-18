import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let opsToken: string;
let clientToken: string;

describe('Campaign API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const opsRes = await request(app).post('/api/v1/auth/login').send({ email: 'ops@stato.app', password: 'ops123' });
    opsToken = opsRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  // Tests run with LEADBYTE_API_KEY unset, so the listCampaigns service
  // returns an empty array per the no-fake-data policy. We verify that the
  // endpoint shape is correct (200 + arrays + total) without asserting on
  // specific entries that no longer exist when running unconfigured.
  describe('GET /api/v1/campaigns', () => {
    it('owner can list campaigns (returns 200 + valid shape)', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.campaigns)).toBe(true);
      expect(typeof res.body.data.total).toBe('number');
    });

    it('ops_manager can list campaigns', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${opsToken}`);
      expect(res.status).toBe(200);
    });

    it('client cannot list campaigns', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('accepts status filter without error', async () => {
      const res = await request(app).get('/api/v1/campaigns?status=active').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      // Any returned rows must match the filter (vacuously true on empty).
      res.body.data.campaigns.forEach((c: any) => expect(c.status).toBe('active'));
    });

    it('accepts search filter without error', async () => {
      const res = await request(app).get('/api/v1/campaigns?search=solar').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.campaigns)).toBe(true);
    });
  });

  describe('GET /api/v1/campaigns/:id', () => {
    it('returns 404 for non-existent campaign', async () => {
      const res = await request(app).get('/api/v1/campaigns/lb-999').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  // Sam Loom 2026-05-15: surface LeadByte buyer caps. Service runs in MOCK
  // mode here (no LEADBYTE_API_KEY) so the endpoint serves the LeadByte mock
  // delivery list — assertion is on shape, not specific data.
  describe('GET /api/v1/campaigns/:id/deliveries', () => {
    it('owner gets 200 + shape with caps when passing a LeadByte id', async () => {
      const res = await request(app)
        .get('/api/v1/campaigns/some-leadbyte-id/deliveries')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.deliveries)).toBe(true);
      // Every delivery row carries a caps object even when individual fields are null.
      for (const d of res.body.data.deliveries) {
        expect(d).toHaveProperty('caps');
        expect(d.caps).toHaveProperty('day');
        expect(d.caps).toHaveProperty('week');
        expect(d.caps).toHaveProperty('month');
        expect(d.caps).toHaveProperty('total');
      }
    });

    it('returns 404 when passing a uuid that does not exist', async () => {
      const res = await request(app)
        .get('/api/v1/campaigns/00000000-0000-0000-0000-000000000000/deliveries')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('client cannot read deliveries', async () => {
      const res = await request(app)
        .get('/api/v1/campaigns/some-leadbyte-id/deliveries')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });
});
