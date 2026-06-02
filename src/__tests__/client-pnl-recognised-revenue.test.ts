import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { getClientPnl } from '../services/report.service.js';
import type { AuthPayload } from '../types/index.js';

/**
 * Regression for fix #2 (audit 2026-06-02): getClientPnl revenue must recognise
 * BOTH 'paid' and 'authorised' invoices (accrual — RECOGNISED_INVOICE_STATUSES),
 * matching getDashboardStats / getFinancialOverview. It previously filtered
 * status='paid' only, so the per-client P&L under-reported authorised-but-unpaid
 * revenue that the dashboard already counts — the two screens then disagreed.
 *
 * Seeds one paid + one authorised invoice (both must count) and one draft
 * (must NOT count) for a fresh tenant, then asserts the client's recognised
 * revenue equals paid + authorised exactly.
 */

const BIZ_ID = randomUUID();
const CLIENT_ID = randomUUID();
const PAID_INVOICE_ID = randomUUID();
const AUTHORISED_INVOICE_ID = randomUUID();
const DRAFT_INVOICE_ID = randomUUID();

const PAID_TOTAL = 1000.0;
const AUTHORISED_TOTAL = 500.0;
const DRAFT_TOTAL = 9999.0; // must be excluded

function authPayload(businessId: string): AuthPayload {
  return {
    userId: `pnl-rev-test-${businessId.slice(-4)}`,
    role: 'owner',
    email: `pnl-rev-${businessId.slice(-4)}@test.local`,
    businessId,
  };
}

describe('getClientPnl — recognises paid + authorised revenue (fix #2)', () => {
  beforeAll(async () => {
    await db.insert(businesses).values({
      id: BIZ_ID, name: 'PnL-rev biz', slug: `pnl-rev-${BIZ_ID.slice(0, 8)}`, status: 'active',
    }).onConflictDoNothing();

    await db.insert(clients).values({
      id: CLIENT_ID, businessId: BIZ_ID, companyName: 'PnL-rev client',
      contactEmail: 'pnl-rev@client.test', currency: 'GBP', status: 'active',
    }).onConflictDoNothing();

    // All three in the current month → inside getClientPnl's 6-month window.
    await db.insert(invoices).values([
      { id: PAID_INVOICE_ID, clientId: CLIENT_ID, invoiceNumber: 'PNL-REV-PAID', status: 'paid', xeroInvoiceId: 'xero-pnl-rev-paid', total: String(PAID_TOTAL), currency: 'GBP', createdAt: new Date() },
      { id: AUTHORISED_INVOICE_ID, clientId: CLIENT_ID, invoiceNumber: 'PNL-REV-AUTH', status: 'authorised', xeroInvoiceId: 'xero-pnl-rev-auth', total: String(AUTHORISED_TOTAL), currency: 'GBP', createdAt: new Date() },
      { id: DRAFT_INVOICE_ID, clientId: CLIENT_ID, invoiceNumber: 'PNL-REV-DRAFT', status: 'draft', xeroInvoiceId: null, total: String(DRAFT_TOTAL), currency: 'GBP', createdAt: new Date() },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(invoices).where(inArray(invoices.id, [PAID_INVOICE_ID, AUTHORISED_INVOICE_ID, DRAFT_INVOICE_ID]));
    await db.delete(clients).where(inArray(clients.id, [CLIENT_ID]));
    await db.delete(businesses).where(inArray(businesses.id, [BIZ_ID]));
  });

  it('includes both paid and authorised, excludes draft', async () => {
    const rows = await getClientPnl(authPayload(BIZ_ID));
    const clientRows = rows.filter((r) => r.clientId === CLIENT_ID);

    // Should be exactly one (client × current-month) row.
    expect(clientRows.length).toBe(1);

    const revenue = clientRows.reduce((sum, r) => sum + r.revenue, 0);
    // paid (1000) + authorised (500) = 1500; draft (9999) must NOT be counted.
    expect(revenue).toBeCloseTo(PAID_TOTAL + AUTHORISED_TOTAL, 2);
    expect(revenue).toBeLessThan(DRAFT_TOTAL);
  });

  it('a paid-only filter would have under-reported — authorised alone is present', async () => {
    // Guard against a regression back to status='paid': if someone reverts the
    // fix, the authorised £500 disappears and revenue drops to 1000.
    const rows = await getClientPnl(authPayload(BIZ_ID));
    const revenue = rows.filter((r) => r.clientId === CLIENT_ID).reduce((s, r) => s + r.revenue, 0);
    expect(revenue).toBeGreaterThan(PAID_TOTAL); // i.e. authorised is included
  });
});
