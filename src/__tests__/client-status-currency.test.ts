import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { clientRevenueFigures } from '../services/client.service.js';

// Feedback round 1 (29 Sep 2026):
//   M3 — euro amounts were shown and summed as pounds (dashboard "Invoices
//        Owed In" total, clients-list revenue).
//   M4 — the Dashboard said "5 Active Clients" while the list showed none as
//        active; 'paused' could not be stored at all.

const tag = `m3m4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;
const createdClientIds: string[] = [];
const createdInvoiceIds: string[] = [];

async function makeClient(name: string, currency: string, status: 'onboarding' | 'active' | 'paused' | 'churned') {
  const [row] = await db
    .insert(clients)
    .values({ businessId: LEADGEN_BUSINESS_ID, companyName: `${name} ${tag}`, currency, status })
    .returning();
  createdClientIds.push(row.id);
  return row.id;
}

async function makeInvoice(clientId: string, currency: string, total: string, status: string, xeroInvoiceId: string | null) {
  const [row] = await db
    .insert(invoices)
    .values({
      clientId,
      invoiceNumber: `INV-${tag}-${createdInvoiceIds.length}`,
      status,
      currency,
      total,
      dueDate: new Date(Date.now() + 10 * 86_400_000),
      xeroInvoiceId,
    })
    .returning();
  createdInvoiceIds.push(row.id);
  return row.id;
}

describe('clientRevenueFigures()', () => {
  it('shows only the client-currency figure, never a cross-currency sum', () => {
    expect(clientRevenueFigures({ EUR: 1000, GBP: 50 }, 'EUR')).toEqual({
      totalRevenue: 1000,
      revenueByCurrency: { EUR: 1000, GBP: 50 },
    });
  });

  it('is 0 in the client currency when all revenue is in another currency', () => {
    expect(clientRevenueFigures({ GBP: 50 }, 'EUR').totalRevenue).toBe(0);
  });

  it('handles a client with no paid invoices', () => {
    expect(clientRevenueFigures(undefined, 'GBP')).toEqual({ totalRevenue: 0, revenueByCurrency: {} });
  });
});

describe('Feedback M3/M4 — status truth + per-currency money', () => {
  let eurClientId: string;

  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    eurClientId = await makeClient('Yash Test Sonova EUR', 'EUR', 'active');
    const gbpClientId = await makeClient('Yash Test Copious GBP', 'GBP', 'onboarding');
    // Outstanding (pushed to Xero): one EUR, one GBP.
    await makeInvoice(eurClientId, 'EUR', '34860.00', 'authorised', `xero-${tag}-eur`);
    await makeInvoice(gbpClientId, 'GBP', '9000.00', 'authorised', `xero-${tag}-gbp`);
    // Paid revenue on the EUR client in two currencies.
    await makeInvoice(eurClientId, 'EUR', '1000.00', 'paid', `xero-${tag}-p1`);
    await makeInvoice(eurClientId, 'GBP', '50.00', 'paid', `xero-${tag}-p2`);
  });

  afterAll(async () => {
    if (createdInvoiceIds.length) await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    if (createdClientIds.length) await db.delete(clients).where(inArray(clients.id, createdClientIds));
  });

  it('GET /invoices/outstanding returns totalsByCurrency and never folds EUR into GBP', async () => {
    const res = await request(app).get('/api/v1/invoices/outstanding').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const totals = res.body.data.totalsByCurrency as Array<{ currency: string; total: string; count: number }>;
    expect(Array.isArray(totals)).toBe(true);
    const eur = totals.find((t) => t.currency === 'EUR');
    const gbp = totals.find((t) => t.currency === 'GBP');
    expect(eur).toBeDefined();
    expect(gbp).toBeDefined();
    expect(Number(eur!.total)).toBeGreaterThanOrEqual(34860);
    expect(Number(gbp!.total)).toBeGreaterThanOrEqual(9000);
    // Every currency appears exactly once, and the per-currency counts add up
    // to the overall count — nothing is dropped or double-counted.
    expect(new Set(totals.map((t) => t.currency)).size).toBe(totals.length);
    expect(totals.reduce((s, t) => s + t.count, 0)).toBe(res.body.data.count);
    // The EUR invoice row itself still carries its own currency.
    const row = res.body.data.invoices.find((i: { clientId: string }) => i.clientId === eurClientId);
    expect(row?.currency).toBe('EUR');
  });

  it('GET /clients reports revenue in the client currency with a per-currency breakdown', async () => {
    const res = await request(app)
      .get(`/api/v1/clients?search=${encodeURIComponent(`Sonova EUR ${tag}`)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const c = res.body.data.clients.find((x: { id: string }) => x.id === eurClientId);
    expect(c).toBeDefined();
    expect(c.currency).toBe('EUR');
    expect(c.totalRevenue).toBe(1000);
    expect(c.revenueByCurrency).toEqual({ EUR: 1000, GBP: 50 });
  });

  it('GET /clients/:id carries the same revenue split', async () => {
    const res = await request(app).get(`/api/v1/clients/${eurClientId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.client.totalRevenue).toBe(1000);
    expect(res.body.data.client.revenueByCurrency).toEqual({ EUR: 1000, GBP: 50 });
  });

  it('accepts status=paused and filters by it', async () => {
    const put = await request(app)
      .put(`/api/v1/clients/${createdClientIds[1]}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'paused' });
    expect(put.status).toBe(200);
    expect(put.body.data.client.status).toBe('paused');

    const list = await request(app)
      .get(`/api/v1/clients?status=paused&search=${encodeURIComponent(tag)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.data.clients.map((c: { id: string }) => c.id)).toEqual([createdClientIds[1]]);
  });

  it('Dashboard activeClients counts status=active only (matches the Active tab)', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const activeRows = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.status, 'active'));
    const onboardingRows = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.status, 'onboarding')));
    expect(res.body.data.activeClients).toBe(activeRows.length);
    // Guard against the old "active + onboarding" count sneaking back.
    if (onboardingRows.length > 0) expect(res.body.data.activeClients).not.toBe(activeRows.length + onboardingRows.length);
  });
});
