import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { adSpend } from '../db/schema/ad-spend.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';

// Regression test: Profit/Margin must always come from rolling-365d revenue
// and rolling-90d cost, regardless of which time-range filter the user
// picks. Before this fix the math used the selected window for both sides,
// which produced -2,047% margin on `this_month` because one week of cost
// landed against zero same-week revenue (invoicing lags spend by 30-60d).

const SEED_CLIENT_ID = '00000000-0000-0000-0000-00000000bc01';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let ownerToken: string;

const isoOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

describe('Dashboard — period-coherent Profit/Margin', () => {
  beforeAll(async () => {
    // Owner token for /dashboard/stats (RBAC-gated).
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;

    // Seed a client we can hang paid invoices on.
    await db
      .insert(clients)
      .values({
        id: SEED_CLIENT_ID,
        businessId: LEADGEN_BUSINESS_ID,
        companyName: 'Coherence Test Ltd',
        contactEmail: 'coherence@test',
        currency: 'GBP',
        status: 'active',
      })
      .onConflictDoNothing();

    // Cost: £1,000 inside the 90d rolling window, £5,000 outside it.
    // Rolling-90d cost should be £1,000.
    await db
      .insert(adSpend)
      .values([
        {
          platform: 'facebook',
          authorizationId: 999001,
          accountId: 'pc-acc-1',
          date: isoOffset(2), // inside 90d
          spend: '1000.00',
          currency: 'GBP',
        },
        {
          platform: 'facebook',
          authorizationId: 999001,
          accountId: 'pc-acc-1',
          date: isoOffset(200), // outside 90d
          spend: '5000.00',
          currency: 'GBP',
        },
      ])
      .onConflictDoNothing();

    // Revenue: £10,000 paid invoice inside the 365d rolling window;
    // £50,000 paid invoice outside it. Rolling-365d revenue = £10,000.
    await db
      .insert(invoices)
      .values([
        {
          clientId: SEED_CLIENT_ID,
          invoiceNumber: 'COHER-IN',
          status: 'paid',
          total: '10000.00',
          dueDate: new Date(isoOffset(60)),
          paidDate: new Date(isoOffset(58)),
        },
        {
          clientId: SEED_CLIENT_ID,
          invoiceNumber: 'COHER-OUT',
          status: 'paid',
          total: '50000.00',
          dueDate: new Date(isoOffset(500)),
          paidDate: new Date(isoOffset(498)),
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.clientId, SEED_CLIENT_ID));
    await db.delete(adSpend).where(eq(adSpend.accountId, 'pc-acc-1'));
    await db.delete(clients).where(eq(clients.id, SEED_CLIENT_ID));
  });

  it('returns rollingRevenue365d + rollingCost90d alongside windowed totals', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/stats?window=last_year')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rollingRevenue365d).toBeGreaterThanOrEqual(10000);
    expect(res.body.data.rollingCost90d).toBeGreaterThanOrEqual(1000);
  });

  it('Profit/Margin do NOT change when the user switches window', async () => {
    const [weekRes, monthRes, yearRes] = await Promise.all([
      request(app).get('/api/v1/dashboard/stats?window=this_week').set('Authorization', `Bearer ${ownerToken}`),
      request(app).get('/api/v1/dashboard/stats?window=this_month').set('Authorization', `Bearer ${ownerToken}`),
      request(app).get('/api/v1/dashboard/stats?window=last_year').set('Authorization', `Bearer ${ownerToken}`),
    ]);

    for (const r of [weekRes, monthRes, yearRes]) expect(r.status).toBe(200);

    const wk = weekRes.body.data;
    const mo = monthRes.body.data;
    const yr = yearRes.body.data;

    // Windowed totals SHOULD differ (Revenue/Cost tiles are lenses).
    // Profit + Margin must stay coherent across windows.
    expect(wk.netProfit).toBe(mo.netProfit);
    expect(mo.netProfit).toBe(yr.netProfit);
    expect(wk.profitMargin).toBe(mo.profitMargin);
    expect(mo.profitMargin).toBe(yr.profitMargin);
  });

  it('netProfit equals rollingRevenue365d minus rollingCost90d', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/stats?window=last_year')
      .set('Authorization', `Bearer ${ownerToken}`);
    const { netProfit, rollingRevenue365d, rollingCost90d } = res.body.data;
    // Round both sides to 2dp before comparing — backend rounds the same.
    const expected = Math.round((rollingRevenue365d - rollingCost90d) * 100) / 100;
    expect(netProfit).toBe(expected);
  });
});
