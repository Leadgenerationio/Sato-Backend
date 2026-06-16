import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
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
import { adSpend } from '../db/schema/ad-spend.js';
import { trafficSources } from '../db/schema/traffic-sources.js';
import { users } from '../db/schema/users.js';

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

  // Sam wants what the client owes surfaced first — outstanding rows
  // (overdue / sent / authorised) before paid, with the most-overdue row
  // at the top of the outstanding bucket.
  describe('Invoice ordering — outstanding first, then due_date ASC', () => {
    const OVERDUE_ID = '00000000-0000-0000-0000-0000000d2001';
    const AUTH_ID = '00000000-0000-0000-0000-0000000d2002';
    const PAID_ID = '00000000-0000-0000-0000-0000000d2003';

    beforeAll(async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      await db
        .insert(invoices)
        .values([
          {
            id: PAID_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-ORD-PAID',
            status: 'paid',
            xeroInvoiceId: 'xero-ord-paid',
            total: '100.00',
            currency: 'GBP',
            dueDate: new Date(now - day),
            paidDate: new Date(now - day),
            createdAt: new Date(now - day),
          },
          {
            id: AUTH_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-ORD-AUTH',
            status: 'authorised',
            xeroInvoiceId: 'xero-ord-auth',
            total: '200.00',
            currency: 'GBP',
            dueDate: new Date(now + 5 * day),
            createdAt: new Date(now - day),
          },
          {
            id: OVERDUE_ID,
            clientId: DEMO_CLIENT_ID,
            invoiceNumber: 'INV-ORD-OVERDUE',
            status: 'overdue',
            xeroInvoiceId: 'xero-ord-overdue',
            total: '300.00',
            currency: 'GBP',
            dueDate: new Date(now - 31 * day),
            createdAt: new Date(now - day),
          },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(invoices).where(eq(invoices.id, OVERDUE_ID));
      await db.delete(invoices).where(eq(invoices.id, AUTH_ID));
      await db.delete(invoices).where(eq(invoices.id, PAID_ID));
    });

    it('returns overdue (oldest due) first, then authorised, then paid', async () => {
      const res = await request(app).get('/api/v1/portal/invoices').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const ours = res.body.data.invoices
        .map((i: { invoiceNumber: string }) => i.invoiceNumber)
        .filter((n: string) => n.startsWith('INV-ORD-'));
      expect(ours).toEqual(['INV-ORD-OVERDUE', 'INV-ORD-AUTH', 'INV-ORD-PAID']);
    });
  });

  // Sam, 2026-05-21 — an invoice 31 days past due was still showing
  // "Authorised" on the portal because the stored `status` column only
  // flips to 'overdue' on the next Xero sync. /portal/invoices now runs
  // each row through deriveDisplayStatus + computeDaysOverdue so the
  // badge label and the days counter reflect reality at request time.
  describe('Invoice status — derived overdue for past-due authorised', () => {
    const OVERDUE_AUTHORISED_ID = '00000000-0000-0000-0000-0000000d3001';

    beforeAll(async () => {
      await db
        .insert(invoices)
        .values({
          id: OVERDUE_AUTHORISED_ID,
          clientId: DEMO_CLIENT_ID,
          invoiceNumber: 'INV-DERIVED-OVERDUE',
          status: 'authorised',
          xeroInvoiceId: 'xero-derived-overdue',
          total: '222.22',
          currency: 'GBP',
          // 31 days ago — stored status is still 'authorised' but the
          // derived display must read 'overdue' with daysOverdue ≥ 31.
          dueDate: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          // daysOverdue column intentionally left null/0 to prove the
          // value on the response is computed live, not read from disk.
        })
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(invoices).where(eq(invoices.id, OVERDUE_AUTHORISED_ID));
    });

    it('past-due authorised invoice surfaces as overdue with live daysOverdue', async () => {
      const res = await request(app).get('/api/v1/portal/invoices').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const row = res.body.data.invoices.find(
        (i: { invoiceNumber: string }) => i.invoiceNumber === 'INV-DERIVED-OVERDUE',
      );
      expect(row).toBeDefined();
      expect(row.status).toBe('overdue');
      // ±1 day tolerance so the test isn't flaky around midnight / DST.
      expect(row.daysOverdue).toBeGreaterThanOrEqual(30);
      expect(row.daysOverdue).toBeLessThanOrEqual(32);
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

  // Managed clients now see their ad spend (per-platform, MTD) in the portal.
  // PPL clients must NOT — that's the no-regression guard. Spend is scoped to
  // the client's own ad_spend rows (client_id) so it matches the agency-side
  // per-client total.
  // Attribution goes through traffic_sources, NOT ad_spend.client_id (which
  // is never populated — that's why the first cut showed empty in prod).
  // Seed: a campaign linked to the demo client, traffic_sources mapping the
  // Catchr accounts to it (FE-style platform names: 'facebook'/'google'),
  // and ad_spend rows on the Catchr-style names ('facebook-ads'/'google-ads')
  // with matching account_ids + NO client_id. The canonical-platform join
  // bridges the two naming schemes.
  describe('Ad spend visibility — managed clients only (traffic_sources attribution)', () => {
    const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a5100';
    const TS_FB = '00000000-0000-0000-0000-0000000a5101';
    const TS_GOOGLE = '00000000-0000-0000-0000-0000000a5102';
    const TS_FB_US = '00000000-0000-0000-0000-0000000a5103';
    const TS_TABOOLA = '00000000-0000-0000-0000-0000000a5104';
    const FB_SPEND_ID = '00000000-0000-0000-0000-0000000a5001';
    const GOOGLE_SPEND_ID = '00000000-0000-0000-0000-0000000a5002';
    const FB_USD_SPEND_ID = '00000000-0000-0000-0000-0000000a5003';
    const BAD_CCY_SPEND_ID = '00000000-0000-0000-0000-0000000a5004';
    const today = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
      await db.insert(campaigns).values({
        id: CAMPAIGN_ID, name: 'Portal ad-spend test campaign', vertical: 'Solar Panels', status: 'active',
      }).onConflictDoNothing();
      await db.insert(clientCampaigns).values({ campaignId: CAMPAIGN_ID, clientId: DEMO_CLIENT_ID }).onConflictDoNothing();

      // traffic_sources link the Catchr accounts to the client's campaign.
      // Platform names are the FE-picker style; the canonical join maps them
      // to the Catchr-style names on ad_spend.
      await db.insert(trafficSources).values([
        { id: TS_FB, campaignId: CAMPAIGN_ID, name: 'FB source', platform: 'facebook', accountId: 'act_portal_fb', accountIds: [], isActive: true },
        { id: TS_GOOGLE, campaignId: CAMPAIGN_ID, name: 'Google source', platform: 'google', accountId: 'act_portal_google', accountIds: [], isActive: true },
        { id: TS_FB_US, campaignId: CAMPAIGN_ID, name: 'FB US source', platform: 'facebook', accountId: 'act_portal_fb_us', accountIds: [], isActive: true },
        { id: TS_TABOOLA, campaignId: CAMPAIGN_ID, name: 'Taboola source', platform: 'taboola', accountId: 'act_portal_taboola', accountIds: [], isActive: true },
      ]).onConflictDoNothing();

      // ad_spend on the Catchr-style platform names, matching account_ids, and
      // crucially NO client_id. The Taboola row carries an EMPTY currency,
      // reproducing the Catchr data that crashed production.
      await db
        .insert(adSpend)
        .values([
          { id: FB_SPEND_ID, platform: 'facebook-ads', authorizationId: 50011, accountId: 'act_portal_fb', campaignId: 'portal-fb', date: today, spend: '120.50', currency: 'GBP' },
          { id: GOOGLE_SPEND_ID, platform: 'google-ads', authorizationId: 50012, accountId: 'act_portal_google', campaignId: 'portal-google', date: today, spend: '300.00', currency: 'GBP' },
          { id: FB_USD_SPEND_ID, platform: 'facebook-ads', authorizationId: 50013, accountId: 'act_portal_fb_us', campaignId: 'portal-fb-us', date: today, spend: '50.00', currency: 'USD' },
          { id: BAD_CCY_SPEND_ID, platform: 'taboola', authorizationId: 50014, accountId: 'act_portal_taboola', campaignId: 'portal-taboola', date: today, spend: '10.00', currency: '' },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(adSpend).where(inArray(adSpend.id, [FB_SPEND_ID, GOOGLE_SPEND_ID, FB_USD_SPEND_ID, BAD_CCY_SPEND_ID]));
      await db.delete(trafficSources).where(inArray(trafficSources.id, [TS_FB, TS_GOOGLE, TS_FB_US, TS_TABOOLA]));
      await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, CAMPAIGN_ID));
      await db.delete(campaigns).where(eq(campaigns.id, CAMPAIGN_ID));
      await db.update(clients).set({ clientType: 'ppl' }).where(eq(clients.id, DEMO_CLIENT_ID));
    });

    it('attributes per-(platform, currency) spend via traffic_sources, sorted by spend desc', async () => {
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));

      const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);

      const rows = res.body.data.adSpendByPlatform as Array<{ platform: string; spend: number; currency: string }>;
      expect(Array.isArray(rows)).toBe(true);

      // Display uses the raw ad_spend.platform (Catchr-style). Keyed by
      // (platform, currency) since a platform can appear in >1 currency.
      const byKey = Object.fromEntries(rows.map((r) => [`${r.platform}|${r.currency}`, r.spend]));
      expect(byKey['facebook-ads|GBP']).toBe(120.5);
      expect(byKey['google-ads|GBP']).toBe(300);
      // The USD Facebook spend is a SEPARATE row — never summed into the GBP one.
      expect(byKey['facebook-ads|USD']).toBe(50);

      // google-ads (£300) sorts before facebook-ads GBP (£120.50). Assert the
      // relative order of our known rows (robust to any unrelated dev rows).
      const gIdx = rows.findIndex((r) => r.platform === 'google-ads' && r.currency === 'GBP');
      const fIdx = rows.findIndex((r) => r.platform === 'facebook-ads' && r.currency === 'GBP');
      expect(gIdx).toBeGreaterThanOrEqual(0);
      expect(fIdx).toBeGreaterThan(gIdx);
    });

    it('does NOT sum spend across currencies (Facebook GBP and USD stay distinct)', async () => {
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));
      const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
      const rows = res.body.data.adSpendByPlatform as Array<{ platform: string; spend: number; currency: string }>;
      const fbRows = rows.filter((r) => r.platform === 'facebook-ads');
      // Two distinct rows, not one £170.50 mega-row.
      expect(fbRows).toHaveLength(2);
      expect(fbRows.some((r) => r.spend === 170.5)).toBe(false);
    });

    it('PPL client gets an empty adSpendByPlatform array (no regression)', async () => {
      await db.update(clients).set({ clientType: 'ppl' }).where(eq(clients.id, DEMO_CLIENT_ID));

      const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      // The data exists + is linked, but PPL must never see it.
      expect(res.body.data.adSpendByPlatform).toEqual([]);
    });

    it('does NOT attribute spend whose Catchr account is not linked via traffic_sources', async () => {
      // Deactivate the Google traffic source — its spend must drop out, proving
      // attribution is link-driven (not client_id / not "all spend").
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));
      await db.update(trafficSources).set({ isActive: false }).where(eq(trafficSources.id, TS_GOOGLE));
      try {
        const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
        const rows = res.body.data.adSpendByPlatform as Array<{ platform: string; currency: string }>;
        expect(rows.find((r) => r.platform === 'google-ads')).toBeUndefined();
        // Facebook (still linked) remains.
        expect(rows.find((r) => r.platform === 'facebook-ads')).toBeDefined();
      } finally {
        await db.update(trafficSources).set({ isActive: true }).where(eq(trafficSources.id, TS_GOOGLE));
      }
    });

    // Regression for the 2026-05-27 production incident: an empty/invalid
    // Catchr currency must surface as a valid code (the FE feeds it into
    // Intl.NumberFormat, which throws RangeError on a bad code).
    it('sanitizes an empty/invalid currency to a valid 3-letter code', async () => {
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));
      const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);

      const rows = res.body.data.adSpendByPlatform as Array<{ platform: string; currency: string }>;
      const taboola = rows.find((r) => r.platform === 'taboola');
      expect(taboola).toBeDefined();
      expect(taboola!.currency).toMatch(/^[A-Z]{3}$/);
      for (const r of rows) {
        expect(() => new Intl.NumberFormat('en-GB', { style: 'currency', currency: r.currency })).not.toThrow();
      }
    });

    // Fix 6b (2026-06-15): getLeadsBySource feeds the portal By Source / Ad
    // Spend card and had NO clientType gate, so PPL clients leaked per-platform
    // spend. Managed clients still get spend; PPL clients must get none.
    it('managed client sees per-platform SPEND in /portal/leads bySource', async () => {
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));

      const res = await request(app).get('/api/v1/portal/leads').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const bySource = res.body.data.bySource as Array<{ platform: string; spend: number }>;
      expect(Array.isArray(bySource)).toBe(true);
      // The seeded ad_spend is linked via traffic_sources, so a managed client
      // gets at least one row with non-zero spend.
      expect(bySource.some((r) => r.spend > 0)).toBe(true);
    });

    it('PPL client gets ZERO spend from /portal/leads bySource (lead sources may still appear)', async () => {
      await db.update(clients).set({ clientType: 'ppl' }).where(eq(clients.id, DEMO_CLIENT_ID));

      const res = await request(app).get('/api/v1/portal/leads').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const bySource = res.body.data.bySource as Array<{ platform: string; spend: number }>;
      expect(Array.isArray(bySource)).toBe(true);
      // No row may carry spend for a pay-per-lead client — the spend figures
      // must be hidden even though the underlying ad_spend data exists.
      for (const r of bySource) {
        expect(r.spend).toBe(0);
      }
    });

    // 2026-06-15: a manually-picked calendar range (no matching LeadByte preset)
    // used to short-circuit to kind:'custom-no-preset-match' with NO breakdown,
    // so the FE showed a "pick a preset" hint and leads stuck at 0. The breakdown
    // is now fetched by the explicit from/to range — window is 'custom' and the
    // bySource array is still computed (real data; empty only if there genuinely
    // is none for the range).
    it('custom (non-preset) date range returns a custom window with a real breakdown, not custom-no-preset-match', async () => {
      await db.update(clients).set({ clientType: 'managed' }).where(eq(clients.id, DEMO_CLIENT_ID));

      // An arbitrary mid-month span that does not line up with any preset.
      const res = await request(app)
        .get('/api/v1/portal/leads?from=2026-02-03&to=2026-02-19')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.bySourceWindow).toEqual({ kind: 'custom' });
      // Breakdown is computed for custom ranges (array present), never the old
      // "no preset → skip entirely" behaviour.
      expect(Array.isArray(res.body.data.bySource)).toBe(true);
    });
  });

  // The portal Creatives tab opened R2 assets via the stored fileUrl, which is
  // a presigned URL that expires (R2 returns the `ExpiredRequest` XML once the
  // X-Amz-Expires window elapses). The FE now fetches a fresh signed URL by
  // r2Key on every open — but that only works if the BE actually returns r2Key
  // in the /portal/creatives response. Pin that here.
  describe('Creatives response — r2Key for fresh signed URL', () => {
    const C_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a6001';
    const C_CREATIVE_ID = '00000000-0000-0000-0000-0000000a6002';
    const C_R2_KEY = '1730000000-test-banner.png';

    beforeAll(async () => {
      await db.insert(campaigns).values({
        id: C_CAMPAIGN_ID, name: 'r2Key test campaign', vertical: 'Solar Panels', status: 'active',
      }).onConflictDoNothing();
      await db.insert(clientCampaigns).values({ campaignId: C_CAMPAIGN_ID, clientId: DEMO_CLIENT_ID }).onConflictDoNothing();
      await db.insert(creatives).values({
        id: C_CREATIVE_ID,
        campaignId: C_CAMPAIGN_ID,
        name: 'test-banner.png',
        // Stored fileUrl mimics a real (now-stale) presigned URL — exactly the
        // shape that crashes once X-Amz-Expires elapses.
        fileUrl: 'https://r2.example.com/creatives/test-banner.png?X-Amz-Expires=900&X-Amz-Signature=stale',
        r2Key: C_R2_KEY,
        type: 'image',
        section: 'media',
        status: 'approved',
        submittedAt: new Date(),
      }).onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(creatives).where(eq(creatives.id, C_CREATIVE_ID));
      await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, C_CAMPAIGN_ID));
      await db.delete(campaigns).where(eq(campaigns.id, C_CAMPAIGN_ID));
    });

    it('returns r2Key on /portal/creatives so the FE can fetch a fresh signed URL', async () => {
      const res = await request(app).get('/api/v1/portal/creatives').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      const all = [...(res.body.data.media ?? []), ...(res.body.data.copyLp ?? [])];
      const item = all.find((c: { id: string }) => c.id === C_CREATIVE_ID);
      expect(item).toBeDefined();
      expect(item.r2Key).toBe(C_R2_KEY);
      // fileUrl is still surfaced for legacy/back-compat callers, but r2Key is
      // the one the portal should use for opening.
      expect(typeof item.fileUrl).toBe('string');
    });
  });

  // Pins the per-creative signed-url endpoint that replaces the FE-side
  // fetchFreshDownloadUrl(folder, key) call. The bug the buyer hit:
  // every legacy creative was uploaded into the misc/ R2 folder (FileUpload
  // folder="misc" on the agency page) but the portal asked for 'creatives/',
  // which is the wrong folder. The FE then fell back to the stale
  // upload-time fileUrl and surfaced R2's ExpiredRequest XML. The new
  // endpoint resolves the real folder server-side from the stored
  // file_url, so a misc-folder legacy row opens cleanly.
  describe('GET /portal/creatives/:id/signed-url — server-resolved folder', () => {
    const SU_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a6101';
    const SU_LEGACY_MISC_ID = '00000000-0000-0000-0000-0000000a6102';
    const SU_NEW_CREATIVES_ID = '00000000-0000-0000-0000-0000000a6103';
    const SU_DRAFT_ID = '00000000-0000-0000-0000-0000000a6104';
    const SU_UNLINKED_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000a6105';
    const SU_UNLINKED_CREATIVE_ID = '00000000-0000-0000-0000-0000000a6106';
    // The DB-seeded owner can be reassigned to a different business between
    // schema resets vs. what data/users.ts uses for in-memory seeds. Look up
    // the owner's actual businessId so the staff-side test passes regardless
    // of which seed ran last.
    const SU_STAFF_CLIENT_ID = '00000000-0000-0000-0000-0000000a6107';

    beforeAll(async () => {
      const [ownerRow] = await db
        .select({ businessId: users.businessId })
        .from(users)
        .where(eq(users.email, 'owner@stato.app'));
      const ownerBusinessId = ownerRow?.businessId;
      if (!ownerBusinessId) throw new Error('owner user not seeded — cannot run signed-url tests');

      // A dedicated client in the owner's business so the staff campaignBelongsToBusiness
      // check passes via the client_campaigns junction. Separate from DEMO_CLIENT_ID
      // (which is tied to the portal-side LEADGEN_BUSINESS_ID and may differ).
      await db.insert(clients).values({
        id: SU_STAFF_CLIENT_ID,
        businessId: ownerBusinessId,
        companyName: 'Signed-url Test Co',
        contactEmail: 'su-test@apex.test',
        currency: 'GBP',
        status: 'active',
      }).onConflictDoNothing();

      await db.insert(campaigns).values([
        { id: SU_CAMPAIGN_ID, name: 'signed-url legacy campaign', vertical: 'Solar Panels', status: 'active' },
        { id: SU_UNLINKED_CAMPAIGN_ID, name: 'unlinked campaign', vertical: 'Solar Panels', status: 'active' },
      ]).onConflictDoNothing();
      await db.insert(clientCampaigns).values([
        { campaignId: SU_CAMPAIGN_ID, clientId: DEMO_CLIENT_ID },
        { campaignId: SU_CAMPAIGN_ID, clientId: SU_STAFF_CLIENT_ID },
      ]).onConflictDoNothing();
      await db.insert(creatives).values([
        {
          // Legacy upload: file_url path says misc/ — pre-fix uploads landed there.
          id: SU_LEGACY_MISC_ID,
          campaignId: SU_CAMPAIGN_ID,
          name: 'legacy-misc.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/misc/1779000000000-legacy.png?X-Amz-Expires=900&X-Amz-Signature=stale',
          r2Key: '1779000000000-legacy.png',
          type: 'image',
          section: 'media',
          status: 'approved',
          submittedAt: new Date(),
        },
        {
          // Post-fix upload: file_url path says creatives/.
          id: SU_NEW_CREATIVES_ID,
          campaignId: SU_CAMPAIGN_ID,
          name: 'new-creatives.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/1779999999999-new.png?X-Amz-Expires=900&X-Amz-Signature=fresh',
          r2Key: '1779999999999-new.png',
          type: 'image',
          section: 'media',
          status: 'approved',
          submittedAt: new Date(),
        },
        {
          // Staff-only draft: must 404 even for the linked client.
          id: SU_DRAFT_ID,
          campaignId: SU_CAMPAIGN_ID,
          name: 'staff-draft.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/creatives/draft.png?X-Amz-Expires=900&X-Amz-Signature=x',
          r2Key: 'draft.png',
          type: 'image',
          section: 'media',
          status: 'draft',
        },
        {
          // Belongs to a campaign NOT linked to DEMO_CLIENT_ID — tenant isolation.
          id: SU_UNLINKED_CREATIVE_ID,
          campaignId: SU_UNLINKED_CAMPAIGN_ID,
          name: 'other-client.png',
          fileUrl: 'https://example.r2.cloudflarestorage.com/stato-production/misc/other.png?X-Amz-Expires=900&X-Amz-Signature=x',
          r2Key: 'other.png',
          type: 'image',
          section: 'media',
          status: 'approved',
          submittedAt: new Date(),
        },
      ]).onConflictDoNothing();
    });

    afterAll(async () => {
      await db.delete(creatives).where(inArray(creatives.id, [
        SU_LEGACY_MISC_ID, SU_NEW_CREATIVES_ID, SU_DRAFT_ID, SU_UNLINKED_CREATIVE_ID,
      ]));
      await db.delete(clientCampaigns).where(eq(clientCampaigns.campaignId, SU_CAMPAIGN_ID));
      await db.delete(campaigns).where(inArray(campaigns.id, [SU_CAMPAIGN_ID, SU_UNLINKED_CAMPAIGN_ID]));
      await db.delete(clients).where(eq(clients.id, SU_STAFF_CLIENT_ID));
    });

    it('opens a legacy misc-folder creative (the bug Sam reported)', async () => {
      const res = await request(app)
        .get(`/api/v1/portal/creatives/${SU_LEGACY_MISC_ID}/signed-url`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.data.url).toBe('string');
      // Mock-mode R2 returns the buildPublicUrl path; either way the folder
      // must be misc (recovered from the file_url path) — never 'creatives'.
      expect(res.body.data.url).toMatch(/\/misc\//);
      expect(res.body.data.url).not.toMatch(/\/creatives\//);
    });

    it('opens a new creatives-folder upload from the correct folder', async () => {
      const res = await request(app)
        .get(`/api/v1/portal/creatives/${SU_NEW_CREATIVES_ID}/signed-url`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/\/creatives\//);
    });

    it('404s a draft (staff-only — buyers must never resolve drafts by id)', async () => {
      const res = await request(app)
        .get(`/api/v1/portal/creatives/${SU_DRAFT_ID}/signed-url`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(404);
    });

    it('404s a creative whose campaign is not linked to the requesting client', async () => {
      const res = await request(app)
        .get(`/api/v1/portal/creatives/${SU_UNLINKED_CREATIVE_ID}/signed-url`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(404);
    });

    it('403s a staff token (portal-only route)', async () => {
      const res = await request(app)
        .get(`/api/v1/portal/creatives/${SU_LEGACY_MISC_ID}/signed-url`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('staff /creatives/:id/signed-url also resolves the misc folder from file_url', async () => {
      const res = await request(app)
        .get(`/api/v1/creatives/${SU_LEGACY_MISC_ID}/signed-url`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/\/misc\//);
    });

    it('staff signed-url 403s a client token', async () => {
      const res = await request(app)
        .get(`/api/v1/creatives/${SU_LEGACY_MISC_ID}/signed-url`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });
});
