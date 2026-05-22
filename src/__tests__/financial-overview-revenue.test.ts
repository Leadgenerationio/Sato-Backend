import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';

// Regression test for the 2026-05-22 "revenue: 0 everywhere" bug.
//
// /api/v1/reports/financial-overview was filtering revenue by
// `status = 'paid'` only. Xero defaults to accrual accounting where
// AUTHORISED (issued, awaiting payment) invoices are recognised revenue —
// the cash-basis-only filter zeroed every legitimately-issued invoice and
// produced revenue:0 across every month even when the invoices table held
// real Xero data. RECOGNISED_INVOICE_STATUSES now widens the filter to
// {'paid','authorised'}; this test seeds one PAID + one AUTHORISED invoice
// and asserts both months' revenue is non-zero.

const SEED_CLIENT_ID = '00000000-0000-0000-0000-00000000fe01';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let ownerToken: string;

// Build a Date at the 15th of the month N months ago (mid-month avoids
// any timezone-rollover oddities at month boundaries).
function midMonthOffset(monthsAgo: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(15);
  d.setHours(12, 0, 0, 0);
  return d;
}

// Reproduces the YYYY-MM key the service uses (en-GB short-month label).
function monthLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

describe('Financial Overview — revenue recognition (paid + authorised)', () => {
  const thisMonthInvoice = midMonthOffset(0);
  const lastMonthInvoice = midMonthOffset(1);

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;

    await db
      .insert(clients)
      .values({
        id: SEED_CLIENT_ID,
        businessId: LEADGEN_BUSINESS_ID,
        companyName: 'Recognition Test Ltd',
        contactEmail: 'recognition@test',
        currency: 'GBP',
        status: 'active',
      })
      .onConflictDoNothing();

    // One PAID invoice this month, one AUTHORISED invoice last month.
    // Both must be picked up by the revenue aggregation.
    await db.insert(invoices).values([
      {
        clientId: SEED_CLIENT_ID,
        invoiceNumber: 'FOV-PAID-1',
        status: 'paid',
        total: '7500.00',
        vatAmount: '1500.00',
        dueDate: thisMonthInvoice,
        paidDate: thisMonthInvoice,
      },
      {
        clientId: SEED_CLIENT_ID,
        invoiceNumber: 'FOV-AUTH-1',
        status: 'authorised',
        total: '4200.00',
        vatAmount: '840.00',
        dueDate: lastMonthInvoice,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.clientId, SEED_CLIENT_ID));
    await db.delete(clients).where(eq(clients.id, SEED_CLIENT_ID));
  });

  it('counts both PAID and AUTHORISED invoices as revenue in their due_date month', async () => {
    const res = await request(app)
      .get('/api/v1/reports/financial-overview')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const report: Array<{ month: string; revenue: number }> = res.body.data.report;
    expect(Array.isArray(report)).toBe(true);

    const thisMonthLabel = monthLabel(thisMonthInvoice);
    const lastMonthLabel = monthLabel(lastMonthInvoice);

    const thisMonthRow = report.find((r) => r.month === thisMonthLabel);
    const lastMonthRow = report.find((r) => r.month === lastMonthLabel);

    expect(thisMonthRow, `expected a row for ${thisMonthLabel}`).toBeDefined();
    expect(lastMonthRow, `expected a row for ${lastMonthLabel}`).toBeDefined();

    // Paid £7,500 must show up in this-month revenue.
    expect(thisMonthRow!.revenue).toBeGreaterThanOrEqual(7500);
    // Authorised £4,200 must show up in last-month revenue — this is the
    // regression: previously the status='paid'-only filter dropped it.
    expect(lastMonthRow!.revenue).toBeGreaterThanOrEqual(4200);
  });

  it('dashboard/stats totalRevenue includes both paid and authorised invoices in window', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/stats?window=last_year')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    // Seeded total: £7,500 paid + £4,200 authorised = £11,700.
    expect(res.body.data.totalRevenue).toBeGreaterThanOrEqual(11700);
    expect(res.body.data.rollingRevenue365d).toBeGreaterThanOrEqual(11700);
  });
});
