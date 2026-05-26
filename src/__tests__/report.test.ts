import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';

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

  describe('GET /api/v1/reports/pnl-summary', () => {
    it('owner gets pnl-summary with unattributedSpendRows exposed', async () => {
      const res = await request(app).get('/api/v1/reports/pnl-summary?days=30').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      // The fix for #74/#109 tenant-bleed: ad_spend rows without a clientId
      // mapping are excluded from this tenant's spend total and surfaced as
      // a separate count so Sam can prompt for the missing mapping.
      expect(typeof res.body.data.unattributedSpendRows).toBe('number');
      expect(res.body.data.unattributedSpendRows).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.data.adSpend).toBe('string');
    });

    it('client cannot access pnl-summary', async () => {
      const res = await request(app).get('/api/v1/reports/pnl-summary').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    // OCT-46 — `getPnlSummary` previously summed invoices.total globally
    // because `invoices` has no business_id column. Once a second tenant is
    // provisioned, the owner's P&L Summary would silently include the other
    // tenant's paid revenue. The fix scopes via INNER JOIN through clients;
    // this test seeds an "alien tenant" + a paid invoice on it and verifies
    // the owner's response doesn't double-count it.
    describe('OCT-46 — multi-tenant isolation', () => {
      const ALIEN_BUSINESS_ID = '00000000-0000-0000-0000-0000000a4601';
      const ALIEN_CLIENT_ID = '00000000-0000-0000-0000-0000000a4602';
      const ALIEN_INVOICE_ID = '00000000-0000-0000-0000-0000000a4603';
      const ALIEN_INVOICE_TOTAL = 999_999.99;

      beforeAll(async () => {
        await db.insert(businesses).values({
          id: ALIEN_BUSINESS_ID,
          name: 'OCT-46 alien tenant',
          slug: 'oct-46-alien',
          status: 'active',
        }).onConflictDoNothing();
        await db.insert(clients).values({
          id: ALIEN_CLIENT_ID,
          businessId: ALIEN_BUSINESS_ID,
          companyName: 'OCT-46 alien client',
          contactEmail: 'oct46@alien.test',
          currency: 'GBP',
          status: 'active',
        }).onConflictDoNothing();
        // Paid invoice on the alien tenant, in the last 30d window — would
        // be included in any global sum.
        await db.insert(invoices).values({
          id: ALIEN_INVOICE_ID,
          clientId: ALIEN_CLIENT_ID,
          invoiceNumber: 'OCT-46-ALIEN-INV',
          status: 'paid',
          xeroInvoiceId: 'xero-oct-46-alien',
          total: String(ALIEN_INVOICE_TOTAL),
          currency: 'GBP',
        }).onConflictDoNothing();
      });

      afterAll(async () => {
        await db.delete(invoices).where(eq(invoices.id, ALIEN_INVOICE_ID));
        await db.delete(clients).where(eq(clients.id, ALIEN_CLIENT_ID));
        await db.delete(businesses).where(inArray(businesses.id, [ALIEN_BUSINESS_ID]));
      });

      it("excludes another tenant's £999,999 paid invoice from the owner's PnL", async () => {
        const res = await request(app).get('/api/v1/reports/pnl-summary?days=30').set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        const ownerRevenue = parseFloat(res.body.data.revenue);
        // The alien £999k must not leak in. We don't assert an exact owner
        // revenue (depends on existing seeded data) — only that the alien's
        // total cannot be present, even hidden in a larger sum.
        expect(ownerRevenue).toBeLessThan(ALIEN_INVOICE_TOTAL);
      });
    });
  });
});
