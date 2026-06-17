/**
 * Tests for downloading the ORIGINAL Xero invoice PDF (Sam, 2026-06-17).
 *
 * The whole point of this feature is that the bytes the user saves come from
 * Xero's `GET /Invoices/{id}` endpoint with `Accept: application/pdf` — NOT a
 * Stato-rendered HTML lookalike. So these tests assert:
 *   1. the request to Xero asks for application/pdf,
 *   2. the controller streams those exact bytes back with PDF headers,
 *   3. a local-only draft (no xeroInvoiceId) is a clean 409, not a fake PDF,
 *   4. the buyer-facing portal route is scoped — you can't pull another
 *      client's invoice.
 *
 * fetch is mocked so no real Xero call happens.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';
import { eq } from 'drizzle-orm';
import * as xero from '../integrations/xero/xero-client.js';

const ORIGINAL_FETCH = global.fetch;
const SAVED_XERO_ENV = { id: process.env.XERO_CLIENT_ID, secret: process.env.XERO_CLIENT_SECRET };

function configureXeroEnv() {
  process.env.XERO_CLIENT_ID = 'test-id';
  process.env.XERO_CLIENT_SECRET = 'test-secret';
}
function restoreXeroEnv() {
  if (SAVED_XERO_ENV.id === undefined) delete process.env.XERO_CLIENT_ID; else process.env.XERO_CLIENT_ID = SAVED_XERO_ENV.id;
  if (SAVED_XERO_ENV.secret === undefined) delete process.env.XERO_CLIENT_SECRET; else process.env.XERO_CLIENT_SECRET = SAVED_XERO_ENV.secret;
}

// Distinctive bytes so we can prove the response is Xero's document verbatim.
const FAKE_XERO_PDF = Buffer.from('%PDF-1.4\nThe real Xero original invoice\n%%EOF');

// supertest doesn't parse application/pdf — collect the raw bytes ourselves.
// Typed loosely to match supertest's parser callback signature.
function binaryParser(
  res: { on(event: string, cb: (chunk: Buffer) => void): void },
  callback: (err: Error | null, body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

/**
 * Mock the 3-call Xero handshake. The PDF call (any GET that asks for
 * application/pdf) returns FAKE_XERO_PDF via arrayBuffer(); records each call
 * so tests can assert the Accept header.
 */
function mockXeroFetch(calls: Array<{ url: string; init: RequestInit }>) {
  global.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/connect/token')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ access_token: 'tok', expires_in: 1800 }), text: async () => '' } as unknown as Response;
    }
    if (String(url).endsWith('/connections')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => [{ id: 'c', tenantId: 'tenant-abc', tenantName: 'Org' }], text: async () => '' } as unknown as Response;
    }
    // /api.xro/2.0/Invoices/{id} with Accept: application/pdf
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: async () => FAKE_XERO_PDF.buffer.slice(FAKE_XERO_PDF.byteOffset, FAKE_XERO_PDF.byteOffset + FAKE_XERO_PDF.byteLength),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('Admin invoice PDF download', () => {
  let ownerToken: string;
  let clientId: string;
  let invoiceId: string;

  beforeEach(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const createClient = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ companyName: `PDF Test Co ${Date.now()}`, companyNumber: '00445790', currency: 'GBP', vatRegistered: true });
    clientId = createClient.body.data.client.id;

    const createInv = await request(app)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ clientId, currency: 'GBP', addVat: true, lineItems: [{ description: 'Leads', quantity: 10, unitPrice: 25, amount: 250 }] });
    invoiceId = createInv.body.data.invoice.id;

    configureXeroEnv();
    xero.__testing.resetCache();
  });

  afterEach(async () => {
    global.fetch = ORIGINAL_FETCH;
    restoreXeroEnv();
    xero.__testing.resetCache();
    await db.delete(invoices).where(eq(invoices.id, invoiceId));
  });

  it('streams the exact Xero PDF bytes and asks Xero for application/pdf', async () => {
    await db.update(invoices).set({ xeroInvoiceId: 'xero-inv-abc', invoiceNumber: 'INV-0415' }).where(eq(invoices.id, invoiceId));

    const calls: Array<{ url: string; init: RequestInit }> = [];
    mockXeroFetch(calls);

    const res = await request(app)
      .get(`/api/v1/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('INV-0415.pdf');
    // The bytes the user saves are Xero's, verbatim.
    expect(Buffer.compare(res.body, FAKE_XERO_PDF)).toBe(0);

    const pdfCall = calls.find((c) => c.url.includes('/api.xro/2.0/Invoices/xero-inv-abc'));
    expect(pdfCall).toBeDefined();
    expect((pdfCall!.init.headers as Record<string, string>)['Accept']).toBe('application/pdf');
    expect((pdfCall!.init.headers as Record<string, string>)['xero-tenant-id']).toBe('tenant-abc');
  });

  it('returns 409 (not 404 / not a fake PDF) for a local draft never pushed to Xero', async () => {
    // invoice has xeroInvoiceId = null by default
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; throw new Error('should not call Xero'); }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`/api/v1/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_in_xero');
    expect(res.body.message).toMatch(/not been issued in xero/i);
    expect(fetchCalled).toBe(false);
  });

  it('returns 404 for an unknown invoice id', async () => {
    const res = await request(app)
      .get('/api/v1/invoices/00000000-0000-0000-0000-0000000000ff/pdf')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Portal invoice PDF download', () => {
  const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
  const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
  let clientToken: string;
  let portalInvoiceId: string;
  let otherInvoiceId: string;
  let otherClientId: string;

  beforeAll(async () => {
    await db.insert(clients).values({
      id: DEMO_CLIENT_ID,
      businessId: LEADGEN_BUSINESS_ID,
      companyName: 'Apex Media Ltd',
      contactEmail: 'contact@apex.test',
      currency: 'GBP',
      status: 'active',
    }).onConflictDoNothing();

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  beforeEach(async () => {
    configureXeroEnv();
    xero.__testing.resetCache();
    // Portal-visible invoice for the logged-in buyer: pushed (has xeroInvoiceId)
    // and a customer-visible status.
    const [vis] = await db.insert(invoices).values({
      clientId: DEMO_CLIENT_ID,
      xeroInvoiceId: 'xero-portal-1',
      invoiceNumber: 'INV-PORTAL-1',
      status: 'sent',
      currency: 'GBP',
      total: '1200.00',
    }).returning({ id: invoices.id });
    portalInvoiceId = vis.id;

    // An invoice belonging to a DIFFERENT client — buyer must not reach it.
    const [other] = await db.insert(clients).values({
      businessId: LEADGEN_BUSINESS_ID,
      companyName: `Other Co ${Date.now()}`,
      currency: 'GBP',
      status: 'active',
    }).returning({ id: clients.id });
    otherClientId = other.id;
    const [oInv] = await db.insert(invoices).values({
      clientId: otherClientId,
      xeroInvoiceId: 'xero-other-1',
      invoiceNumber: 'INV-OTHER-1',
      status: 'sent',
      currency: 'GBP',
      total: '999.00',
    }).returning({ id: invoices.id });
    otherInvoiceId = oInv.id;
  });

  afterEach(async () => {
    global.fetch = ORIGINAL_FETCH;
    restoreXeroEnv();
    xero.__testing.resetCache();
    await db.delete(invoices).where(eq(invoices.id, portalInvoiceId));
    await db.delete(invoices).where(eq(invoices.id, otherInvoiceId));
    await db.delete(clients).where(eq(clients.id, otherClientId));
  });

  it('lets the buyer download their own invoice as the real Xero PDF', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mockXeroFetch(calls);

    const res = await request(app)
      .get(`/api/v1/portal/invoices/${portalInvoiceId}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('INV-PORTAL-1.pdf');
    expect(Buffer.compare(res.body, FAKE_XERO_PDF)).toBe(0);
    expect(calls.some((c) => c.url.includes('/api.xro/2.0/Invoices/xero-portal-1'))).toBe(true);
  });

  it("returns 404 for another client's invoice and never calls Xero", async () => {
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; throw new Error('should not call Xero'); }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`/api/v1/portal/invoices/${otherInvoiceId}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });
});
