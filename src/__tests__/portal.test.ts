import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeApprovals } from '../db/schema/creative-approvals.js';
import { invoices } from '../db/schema/invoices.js';
import { agreements } from '../db/schema/agreements.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';

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

  // Drafts are internal pre-authorisation state. They must NEVER appear in
  // the buyer-facing list or contribute to the outstanding/pending tiles —
  // otherwise the buyer is chased for invoices we haven't actually issued.
  describe('Invoice visibility — draft / voided filter', () => {
    const DRAFT_INV_ID = '00000000-0000-0000-0000-0000000d0001';
    const VOIDED_INV_ID = '00000000-0000-0000-0000-0000000d0002';
    const AUTHORISED_INV_ID = '00000000-0000-0000-0000-0000000d0003';

    beforeAll(async () => {
      await db
        .insert(invoices)
        .values([
          {
            id: DRAFT_INV_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-DRAFT',
            status: 'draft',
            total: '999.99',
            currency: 'GBP',
            dueDate: new Date('2026-12-01'),
          },
          {
            id: VOIDED_INV_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-VOIDED',
            status: 'voided',
            total: '555.55',
            currency: 'GBP',
            dueDate: new Date('2026-12-01'),
          },
          {
            id: AUTHORISED_INV_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-OK',
            status: 'authorised',
            // T5: a "real" outstanding invoice has been pushed to Xero and
            // therefore has a non-null xero_invoice_id. Without this the
            // structural guard excludes the row from the outstanding tile.
            xeroInvoiceId: 'xero-fixture-ok-001',
            total: '111.11',
            currency: 'GBP',
            dueDate: new Date('2026-12-01'),
          },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(invoices).where(eq(invoices.id, DRAFT_INV_ID));
      await db.delete(invoices).where(eq(invoices.id, VOIDED_INV_ID));
      await db.delete(invoices).where(eq(invoices.id, AUTHORISED_INV_ID));
    });

    it('portal /invoices excludes draft and voided rows', async () => {
      const res = await request(app).get('/api/v1/portal/invoices').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const numbers = res.body.data.invoices.map((i: { invoiceNumber: string }) => i.invoiceNumber);
      expect(numbers).toContain('INV-OK');
      expect(numbers).not.toContain('INV-DRAFT');
      expect(numbers).not.toContain('INV-VOIDED');
    });

    it('portal /dashboard outstanding tile excludes the £999 draft + £555 voided', async () => {
      const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      // Outstanding includes the £111.11 authorised row but neither hidden
      // status, so the sum must be < 999 + 555 + anything-else-prior. We
      // assert specifically that £999.99 (draft) is NOT in the total.
      const outstanding = res.body.data.totalOutstanding as number;
      expect(outstanding).toBeGreaterThanOrEqual(111.11);
      expect(outstanding).toBeLessThan(999.99);
    });
  });

  // Campaigns in admin-only workflow states (draft/archived/deleted) must
  // not appear on the portal Campaigns tab — but paused/ended/churned
  // remain visible so historical leads have a parent campaign in the UI.
  describe('Campaign visibility — admin-only states hidden', () => {
    const ACTIVE_CAMP_ID = '00000000-0000-0000-0000-0000000c4001';
    const DRAFT_CAMP_ID = '00000000-0000-0000-0000-0000000c4002';
    const ARCHIVED_CAMP_ID = '00000000-0000-0000-0000-0000000c4003';
    const PAUSED_CAMP_ID = '00000000-0000-0000-0000-0000000c4004';

    const allIds = [ACTIVE_CAMP_ID, DRAFT_CAMP_ID, ARCHIVED_CAMP_ID, PAUSED_CAMP_ID];

    beforeAll(async () => {
      await db
        .insert(campaigns)
        .values([
          { id: ACTIVE_CAMP_ID, clientId: DEMO_CLIENT_ID, name: 'Active Camp', status: 'active' },
          { id: DRAFT_CAMP_ID, clientId: DEMO_CLIENT_ID, name: 'Draft Camp', status: 'draft' },
          { id: ARCHIVED_CAMP_ID, clientId: DEMO_CLIENT_ID, name: 'Archived Camp', status: 'archived' },
          { id: PAUSED_CAMP_ID, clientId: DEMO_CLIENT_ID, name: 'Paused Camp', status: 'paused' },
        ])
        .onConflictDoNothing();
      // getCampaigns resolves linkage via the client_campaigns junction
      // (not the legacy campaigns.client_id column) — must seed both for
      // the rows to show up.
      await db
        .insert(clientCampaigns)
        .values(allIds.map((campaignId) => ({ clientId: DEMO_CLIENT_ID, campaignId })))
        .onConflictDoNothing();
    });

    afterAll(async () => {
      for (const id of allIds) {
        await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, id));
        await db.delete(campaigns).where(eq(campaigns.id, id));
      }
    });

    it('portal /campaigns hides draft + archived but keeps paused', async () => {
      const res = await request(app).get('/api/v1/portal/campaigns').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const names = res.body.data.campaigns.map((c: { name: string }) => c.name);
      expect(names).toContain('Active Camp');
      expect(names).toContain('Paused Camp');
      expect(names).not.toContain('Draft Camp');
      expect(names).not.toContain('Archived Camp');
    });
  });

  // The agreement returned to the portal must be the latest meaningful one —
  // never a draft, never a cancelled row, and a signed agreement must beat
  // a more-recently-created draft / pending row.
  describe('Agreement selection — prefer signed/sent, hide drafts', () => {
    const SIGNED_AG_ID = '00000000-0000-0000-0000-0000000a5001';
    const DRAFT_AG_ID = '00000000-0000-0000-0000-0000000a5002';
    const CANCELLED_AG_ID = '00000000-0000-0000-0000-0000000a5003';

    beforeAll(async () => {
      // Create a signed row first (older), then a draft (newer) — without
      // the fix the draft would win on createdAt desc and shadow the signed.
      const olderDate = new Date(Date.now() - 7 * 86_400_000);
      const newerDate = new Date();
      await db
        .insert(agreements)
        .values([
          {
            id: SIGNED_AG_ID,
            clientId: DEMO_CLIENT_ID,
            status: 'signed',
            signedAt: olderDate,
            sentAt: olderDate,
            createdAt: olderDate,
          },
          {
            id: DRAFT_AG_ID,
            clientId: DEMO_CLIENT_ID,
            status: 'draft',
            createdAt: newerDate,
          },
          {
            id: CANCELLED_AG_ID,
            clientId: DEMO_CLIENT_ID,
            status: 'cancelled',
            createdAt: newerDate,
          },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      for (const id of [SIGNED_AG_ID, DRAFT_AG_ID, CANCELLED_AG_ID]) {
        await db.delete(agreements).where(eq(agreements.id, id));
      }
    });

    it('portal /agreement returns the older signed row, not the newer draft', async () => {
      const res = await request(app).get('/api/v1/portal/agreement').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.agreement).not.toBeNull();
      expect(res.body.data.agreement.id).toBe(SIGNED_AG_ID);
      expect(res.body.data.agreement.status).toBe('signed');
    });
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
