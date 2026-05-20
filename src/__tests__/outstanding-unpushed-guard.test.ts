import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import {
  isOutstandingInvoice,
  getOutstandingInvoices,
} from '../services/invoice.service.js';
import type { AuthPayload } from '../types/index.js';

// T5 (Sam, 2026-05-20) — locks in the structural guard against the £44k
// portal-Outstanding inflation. The bug was: an auto-invoice run wrote a
// row with status='sent' but never pushed it to Xero (xero_invoice_id
// was null), and every outstanding aggregation treated it as real.
//
// These tests assert the rule from three angles:
//   1. The shared isOutstandingInvoice() predicate excludes unpushed rows.
//   2. getOutstandingInvoices() (admin dashboard / /api/v1/invoices/
//      outstanding) excludes them.
//   3. /api/v1/portal/dashboard totalOutstanding excludes them.
//   4. /api/v1/portal/invoices excludes them.
// Plus the positive case for each — a normal pushed invoice still counts.

const tag = `t5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;
let clientToken: string;

const OWNER_AUTH: AuthPayload = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'owner@stato.app',
  role: 'owner',
  businessId: LEADGEN_BUSINESS_ID,
};

const createdInvoiceIds: string[] = [];

async function makeInvoice(opts: {
  status: string;
  xeroInvoiceId: string | null;
  total: string;
  dueDate?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(invoices)
    .values({
      clientId: DEMO_CLIENT_ID,
      invoiceNumber: `INV-${tag}-${createdInvoiceIds.length}`,
      status: opts.status,
      total: opts.total,
      currency: 'GBP',
      dueDate: opts.dueDate ?? new Date(Date.now() + 30 * 86_400_000),
      xeroInvoiceId: opts.xeroInvoiceId,
    })
    .returning();
  createdInvoiceIds.push(row.id);
  return row.id;
}

describe('Outstanding aggregation — xero_invoice_id IS NOT NULL guard (T5)', () => {
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

    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (createdInvoiceIds.length > 0) {
      await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    }
  });

  // 1. Helper-level predicate.
  it('isOutstandingInvoice() returns false for an unpushed sent invoice', () => {
    expect(isOutstandingInvoice({ status: 'sent', xeroInvoiceId: null })).toBe(false);
    expect(isOutstandingInvoice({ status: 'authorised', xeroInvoiceId: null })).toBe(false);
    expect(isOutstandingInvoice({ status: 'overdue', xeroInvoiceId: null })).toBe(false);
  });

  it('isOutstandingInvoice() returns true for a pushed sent / authorised / overdue invoice', () => {
    expect(isOutstandingInvoice({ status: 'sent', xeroInvoiceId: 'x-1' })).toBe(true);
    expect(isOutstandingInvoice({ status: 'authorised', xeroInvoiceId: 'x-2' })).toBe(true);
    expect(isOutstandingInvoice({ status: 'overdue', xeroInvoiceId: 'x-3' })).toBe(true);
  });

  it('isOutstandingInvoice() returns false for paid / draft / voided regardless of xero id', () => {
    expect(isOutstandingInvoice({ status: 'paid', xeroInvoiceId: 'x-paid' })).toBe(false);
    expect(isOutstandingInvoice({ status: 'draft', xeroInvoiceId: 'x-draft' })).toBe(false);
    expect(isOutstandingInvoice({ status: 'voided', xeroInvoiceId: 'x-void' })).toBe(false);
  });

  // 2. Admin service-level aggregation.
  it('getOutstandingInvoices excludes unpushed sent + includes pushed sent', async () => {
    const unpushed = await makeInvoice({ status: 'sent', xeroInvoiceId: null, total: '17880' });
    const pushed = await makeInvoice({ status: 'sent', xeroInvoiceId: `xfix-${tag}-ok`, total: '500' });

    const result = await getOutstandingInvoices(OWNER_AUTH, 'all');
    const ids = result.invoices.map((i) => i.id);
    expect(ids).not.toContain(unpushed);
    expect(ids).toContain(pushed);
  });

  // 3. Admin HTTP endpoint.
  it('GET /api/v1/invoices/outstanding excludes the unpushed row', async () => {
    const unpushed = await makeInvoice({ status: 'sent', xeroInvoiceId: null, total: '21465' });
    const res = await request(app)
      .get('/api/v1/invoices/outstanding')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.invoices.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(unpushed);
  });

  // 4. Portal dashboard tile.
  it('GET /api/v1/portal/dashboard totalOutstanding excludes the unpushed row', async () => {
    const unpushed = await makeInvoice({ status: 'sent', xeroInvoiceId: null, total: '44000' });
    const res = await request(app)
      .get('/api/v1/portal/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    // The unpushed £44k row must not contribute to the tile. We can't
    // assert exact equality because the test DB carries other fixtures,
    // but the tile total must be strictly less than 44_000 (no other
    // single-fixture pushes that high).
    expect(res.body.data.totalOutstanding).toBeLessThan(44000);
    // Sanity: the row is in the DB, we just don't surface it via the tile.
    const [row] = await db.select().from(invoices).where(eq(invoices.id, unpushed));
    expect(row.status).toBe('sent');
    expect(row.xeroInvoiceId).toBeNull();
  });

  // 5. Portal invoices list.
  it('GET /api/v1/portal/invoices excludes the unpushed row', async () => {
    const unpushed = await makeInvoice({ status: 'sent', xeroInvoiceId: null, total: '12345' });
    const res = await request(app)
      .get('/api/v1/portal/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.invoices.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(unpushed);
  });

  // 6. Positive case end-to-end — pushed invoice flows through.
  it('a pushed authorised invoice appears on both admin outstanding + portal list', async () => {
    const pushed = await makeInvoice({ status: 'authorised', xeroInvoiceId: `xfix-${tag}-pos`, total: '777' });

    const adminRes = await request(app)
      .get('/api/v1/invoices/outstanding')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(adminRes.body.data.invoices.map((i: { id: string }) => i.id)).toContain(pushed);

    const portalRes = await request(app)
      .get('/api/v1/portal/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(portalRes.body.data.invoices.map((i: { id: string }) => i.id)).toContain(pushed);
  });
});
