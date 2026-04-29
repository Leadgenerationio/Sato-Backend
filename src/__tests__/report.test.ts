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
});
