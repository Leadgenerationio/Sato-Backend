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

  it('owner can get campaign performance report', async () => {
    const res = await request(app).get('/api/v1/reports/campaign-performance').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.report.length).toBeGreaterThan(0);
    expect(res.body.data.report[0].campaignName).toBeDefined();
    expect(res.body.data.report[0].revenue).toBeDefined();
    expect(res.body.data.report[0].margin).toBeDefined();
  });

  it('owner can get client P&L report', async () => {
    const res = await request(app).get('/api/v1/reports/client-pnl').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.report.length).toBeGreaterThan(0);
    expect(res.body.data.report[0].clientName).toBeDefined();
    expect(res.body.data.report[0].profit).toBeDefined();
  });

  it('owner can get supplier performance report', async () => {
    const res = await request(app).get('/api/v1/reports/supplier-performance').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.report.length).toBeGreaterThan(0);
    expect(res.body.data.report[0].supplierName).toBeDefined();
    expect(res.body.data.report[0].cpl).toBeDefined();
  });

  it('owner can get financial overview report', async () => {
    const res = await request(app).get('/api/v1/reports/financial-overview').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.report.length).toBe(12);
    expect(res.body.data.report[0].revenue).toBeDefined();
    expect(res.body.data.report[0].vatCollected).toBeDefined();
  });

  it('client cannot access reports', async () => {
    const res = await request(app).get('/api/v1/reports/campaign-performance').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });
});
