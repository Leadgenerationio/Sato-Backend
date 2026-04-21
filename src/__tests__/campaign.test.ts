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

  describe('GET /api/v1/campaigns', () => {
    it('owner can list campaigns', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.campaigns).toBeDefined();
      expect(res.body.data.campaigns.length).toBeGreaterThan(0);
    });

    it('ops_manager can list campaigns', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${opsToken}`);
      expect(res.status).toBe(200);
    });

    it('client cannot list campaigns', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/v1/campaigns?status=active').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.campaigns.forEach((c: any) => expect(c.status).toBe('active'));
    });

    it('filters by search', async () => {
      const res = await request(app).get('/api/v1/campaigns?search=solar').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.campaigns.length).toBeGreaterThan(0);
    });

    it('campaign has expected fields', async () => {
      const res = await request(app).get('/api/v1/campaigns').set('Authorization', `Bearer ${ownerToken}`);
      const campaign = res.body.data.campaigns[0];
      expect(campaign.id).toBeDefined();
      expect(campaign.name).toBeDefined();
      expect(campaign.clientName).toBeDefined();
      expect(campaign.totalRevenue).toBeDefined();
      expect(campaign.cpl).toBeDefined();
      expect(campaign.margin).toBeDefined();
      expect(campaign.leadsToday).toBeDefined();
    });
  });

  describe('GET /api/v1/campaigns/:id', () => {
    it('returns campaign detail with deliveries and suppliers', async () => {
      const res = await request(app).get('/api/v1/campaigns/lb-1').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.name).toBeDefined();
      expect(res.body.data.campaign.leadDeliveries).toBeDefined();
      expect(res.body.data.campaign.leadDeliveries.length).toBeGreaterThan(0);
      expect(res.body.data.campaign.suppliers).toBeDefined();
    });

    it('returns 404 for non-existent campaign', async () => {
      const res = await request(app).get('/api/v1/campaigns/lb-999').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });
});
