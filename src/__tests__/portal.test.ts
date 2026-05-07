import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeApprovals } from '../db/schema/creative-approvals.js';

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
    expect(['managed', 'ppl']).toContain(res.body.data.clientType);
  });

  it('managed client gets clientType=managed on dashboard', async () => {
    await db
      .update(clients)
      .set({ clientType: 'managed' })
      .where(eq(clients.id, DEMO_CLIENT_ID));

    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.clientType).toBe('managed');

    // Restore default so other tests aren't surprised.
    await db
      .update(clients)
      .set({ clientType: 'ppl' })
      .where(eq(clients.id, DEMO_CLIENT_ID));
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
    // Each lead row carries campaignId so the FE can group by delivery without
    // depending on campaign-name uniqueness.
    for (const lead of res.body.data.leads) {
      expect(lead.campaignId).toMatch(/^[0-9a-f-]{36}$/);
    }
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

  // ─── Asset approval (Roadmap C — solicitor compliance) ───
  //
  // Each test seeds its own creative + cleans up its approvals, so order
  // doesn't matter and tests don't leak rows into each other.

  describe('Asset approval flow', () => {
    const TEST_CAMPAIGN_ID = '00000000-0000-0000-0000-000000000c01';
    const TEST_CREATIVE_ID = '00000000-0000-0000-0000-000000000cc1';

    beforeAll(async () => {
      await db
        .insert(campaigns)
        .values({
          id: TEST_CAMPAIGN_ID,
          clientId: DEMO_CLIENT_ID,
          name: 'Test Campaign for Approval',
          status: 'active',
        })
        .onConflictDoNothing();

      await db
        .insert(creatives)
        .values({
          id: TEST_CREATIVE_ID,
          campaignId: TEST_CAMPAIGN_ID,
          name: 'banner-v1.png',
          fileUrl: 'https://example.com/banner-v1.png',
          type: 'image',
        })
        .onConflictDoNothing();
    });

    it('compliance endpoint includes approval status per creative (default: pending)', async () => {
      // Clear any prior decisions so this test sees the default state.
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      const res = await request(app).get('/api/v1/portal/compliance').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const allCreatives = res.body.data.compliance.flatMap((c: { creatives: unknown[] }) => c.creatives);
      const target = allCreatives.find((cr: { id: string }) => cr.id === TEST_CREATIVE_ID);
      expect(target).toBeDefined();
      expect(target.approval.status).toBe('pending');
    });

    it('approve endpoint records decision with IP + user-agent + user', async () => {
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      const res = await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/approve`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('User-Agent', 'vitest-supertest/1.0')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.event.action).toBe('approved');
      // IP capture — supertest hits 127.0.0.1 / ::1 / ::ffff:127.0.0.1 depending on stack.
      expect(res.body.data.event.ipAddress).toMatch(/127\.0\.0\.1|::1|::ffff/);
      expect(res.body.data.event.userAgent).toContain('vitest-supertest');
      expect(res.body.data.event.decidedByUserId).toBeDefined();
    });

    it('reject endpoint requires feedback', async () => {
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      const res = await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/reject`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({}); // no feedback

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/feedback/i);
    });

    it('reject endpoint records decision with feedback when provided', async () => {
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      const res = await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/reject`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ feedback: 'Logo too small, please increase by 30%' });

      expect(res.status).toBe(200);
      expect(res.body.data.event.action).toBe('rejected');
      expect(res.body.data.event.feedback).toContain('Logo too small');
    });

    it('compliance endpoint reflects most recent decision after approval', async () => {
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/approve`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({});

      const res = await request(app).get('/api/v1/portal/compliance').set('Authorization', `Bearer ${clientToken}`);
      const allCreatives = res.body.data.compliance.flatMap((c: { creatives: unknown[] }) => c.creatives);
      const target = allCreatives.find((cr: { id: string }) => cr.id === TEST_CREATIVE_ID);
      expect(target.approval.status).toBe('approved');
      expect(target.approval.decidedAt).toBeTruthy();
    });

    it('owner can fetch full approval audit history for a creative', async () => {
      await db.delete(creativeApprovals).where(eq(creativeApprovals.creativeId, TEST_CREATIVE_ID));

      // Two decisions: reject then approve. Audit must show both.
      await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/reject`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ feedback: 'Wrong CTA' });
      await request(app)
        .post(`/api/v1/portal/creatives/${TEST_CREATIVE_ID}/approve`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({});

      const res = await request(app)
        .get(`/api/v1/creatives/${TEST_CREATIVE_ID}/approval-history`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const events = res.body.data.events;
      expect(events).toHaveLength(2);
      // Sorted desc by createdAt — most recent first.
      expect(events[0].action).toBe('approved');
      expect(events[1].action).toBe('rejected');
      expect(events[1].feedback).toBe('Wrong CTA');
    });
  });
});
