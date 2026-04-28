import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';

let clientToken: string;
let ownerToken: string;

// In-memory user store has client@stato.app → clientId = this UUID.
// Portal queries scope to that ID and call loadClientOrThrow → 403 if absent.
// Self-seed so the test doesn't depend on db:seed having run.
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

describe('Portal API', () => {
  beforeAll(async () => {
    await db
      .insert(clients)
      .values({
        id: DEMO_CLIENT_ID,
        businessId: LEADGEN_BUSINESS_ID,
        companyName: 'Apex Media Ltd',
        contactEmail: 'contact@apex.test',
        currency: 'GBP',
        status: 'active',
      })
      .onConflictDoNothing();

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
  });

  it('client can access portal dashboard', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.companyName).toBeDefined();
    expect(typeof res.body.data.activeCampaigns).toBe('number');
    expect(Array.isArray(res.body.data.recentLeads)).toBe(true);
    expect(res.body.data.recentLeads.length).toBe(14); // always 14 days
  });

  it('owner cannot access portal', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  it('client can view portal campaigns', async () => {
    const res = await request(app).get('/api/v1/portal/campaigns').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.campaigns)).toBe(true);
  });

  it('client can view portal leads', async () => {
    const res = await request(app).get('/api/v1/portal/leads').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.leads)).toBe(true);
    expect(res.body.data.range).toBeDefined();
    expect(res.body.data.range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('portal leads accepts custom from/to range and echoes it back', async () => {
    const res = await request(app)
      .get('/api/v1/portal/leads?from=2026-01-01&to=2026-03-30')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.range.from).toBe('2026-01-01');
    expect(res.body.data.range.to).toBe('2026-03-30');
  });

  it('portal leads ignores malformed dates and falls back to default window', async () => {
    const res = await request(app)
      .get('/api/v1/portal/leads?from=garbage&to=also-garbage')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    // Default window: 30 days ago → today. Range still well-formed.
    expect(res.body.data.range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('portal leads swaps reversed from>to so the response is never empty due to typo', async () => {
    const res = await request(app)
      .get('/api/v1/portal/leads?from=2026-03-30&to=2026-01-01')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.range.from).toBe('2026-01-01');
    expect(res.body.data.range.to).toBe('2026-03-30');
  });

  it('client can view portal invoices', async () => {
    const res = await request(app).get('/api/v1/portal/invoices').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.invoices)).toBe(true);
  });

  it('client can view portal compliance', async () => {
    const res = await request(app).get('/api/v1/portal/compliance').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.compliance)).toBe(true);
  });

  it('client can view portal agreement (may be null when none exists)', async () => {
    const res = await request(app).get('/api/v1/portal/agreement').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    if (res.body.data.agreement) {
      expect(res.body.data.agreement.status).toBeDefined();
      expect(res.body.data.agreement.terms).toBeDefined();
    }
  });

  it('unauthenticated cannot access portal', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard');
    expect(res.status).toBe(401);
  });
});
