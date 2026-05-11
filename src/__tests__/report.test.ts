import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;

describe('Report API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  // Per the no-fake-data policy, reports return empty arrays in the test env
  // (no LeadByte key, empty DB). We verify endpoint shape + RBAC, not entries.
  it('owner can get campaign performance report (200 + valid shape)', async () => {
    const res = await request(app).get('/api/v1/reports/campaign-performance').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.report)).toBe(true);
  });

  it('owner can get client P&L report (200 + valid shape)', async () => {
    const res = await request(app).get('/api/v1/reports/client-pnl').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.report)).toBe(true);
  });

  it('owner can get supplier performance report (200 + valid shape)', async () => {
    const res = await request(app).get('/api/v1/reports/supplier-performance').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.report)).toBe(true);
  });

  it('owner can get financial overview report (200 + valid shape)', async () => {
    const res = await request(app).get('/api/v1/reports/financial-overview').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.report)).toBe(true);
  });

  it('client cannot access reports', async () => {
    const res = await request(app).get('/api/v1/reports/campaign-performance').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  // Slice 4 Day 1: unified leadreports.io-style report. Test env has no
  // LeadByte key so rows will be empty — we verify the response shape,
  // filter handling, totals math, and RBAC.
  describe('Unified report (Sam Loom #72-85)', () => {
    it('returns the unified shape — rows[] + totals + echoed window', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.window).toBe('this_month');
      expect(Array.isArray(res.body.data.rows)).toBe(true);
      expect(res.body.data.totals).toMatchObject({
        leads: expect.any(Number),
        spend: expect.any(Number),
        revenue: expect.any(Number),
        profit: expect.any(Number),
        margin: expect.any(Number),
      });
    });

    it('accepts window=last_month and echoes it', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified?window=last_month')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.window).toBe('last_month');
    });

    it('falls back to this_month when window param is invalid', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified?window=garbage')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.window).toBe('this_month');
    });

    it('echoes supplier + campaign filters when provided', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified?supplier=facebook&campaign=solar')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.supplier).toBe('facebook');
      expect(res.body.data.campaign).toBe('solar');
    });

    it('client role is blocked', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('totals are mathematically consistent with rows (when populated)', async () => {
      const res = await request(app)
        .get('/api/v1/reports/unified')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const { rows, totals } = res.body.data;
      type Row = { leads: number; spend: number; revenue: number; profit: number };
      const sumLeads = rows.reduce((s: number, r: Row) => s + r.leads, 0);
      const sumSpend = Math.round(rows.reduce((s: number, r: Row) => s + r.spend, 0) * 100) / 100;
      const sumRevenue = Math.round(rows.reduce((s: number, r: Row) => s + r.revenue, 0) * 100) / 100;
      expect(totals.leads).toBe(sumLeads);
      expect(totals.spend).toBe(sumSpend);
      expect(totals.revenue).toBe(sumRevenue);
    });
  });
});
