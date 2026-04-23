/**
 * Unit tests for the Xero invoice-push flow. Uses a mocked fetch so no real
 * Xero API calls happen. The higher-level integration test in `invoice.test.ts`
 * only covers the 404 case; happy-path verification is here so we can assert
 * the request body shape without polluting Sam's live Xero books.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { eq } from 'drizzle-orm';
import * as xero from '../integrations/xero/xero-client.js';

const ORIGINAL_FETCH = global.fetch;

describe('Invoice push to Xero', () => {
  let ownerToken: string;
  let clientId: string;
  let invoiceId: string;

  beforeEach(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const createClient = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Push Test Co ${Date.now()}`,
        companyNumber: '00445790',
        currency: 'GBP',
        vatRegistered: true,
      });
    clientId = createClient.body.data.client.id;

    const createInv = await request(app)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId,
        currency: 'GBP',
        addVat: true,
        lineItems: [{ description: 'Solar Panel Leads', quantity: 40, unitPrice: 12.5, amount: 500 }],
      });
    invoiceId = createInv.body.data.invoice.id;

    // Bypass real OAuth by stubbing getValidToken via Xero client cache.
    xero.__testing.resetCache();
  });

  afterEach(async () => {
    global.fetch = ORIGINAL_FETCH;
    xero.__testing.resetCache();
    // Clean up the invoice + client we created so tests don't leak.
    await db.delete(invoices).where(eq(invoices.id, invoiceId));
  });

  it('pushes the invoice to Xero and stores the returned InvoiceID', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/connect/token')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ access_token: 'tok', expires_in: 1800 }),
          text: async () => '',
        } as unknown as Response;
      }
      if (String(url).endsWith('/connections')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => [{ id: 'c', tenantId: 'tenant-abc', tenantName: 'Test Org' }],
          text: async () => '',
        } as unknown as Response;
      }
      // /api.xro/2.0/Invoices
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          Invoices: [{ InvoiceID: 'xero-inv-xyz-123', InvoiceNumber: 'INV-9001' }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/v1/invoices/${invoiceId}/push-to-xero`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.invoice.xeroInvoiceId).toBe('xero-inv-xyz-123');
    expect(res.body.data.invoice.invoiceNumber).toBe('INV-9001');

    const xeroCall = calls.find((c) => c.url.includes('/api.xro/2.0/Invoices'));
    expect(xeroCall).toBeDefined();
    expect(xeroCall!.init.method).toBe('POST');
    const headers = xeroCall!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['xero-tenant-id']).toBe('tenant-abc');

    const body = JSON.parse(String(xeroCall!.init.body));
    expect(body.Invoices?.[0]?.Type).toBe('ACCREC');
    expect(body.Invoices?.[0]?.Status).toBe('DRAFT');
    expect(body.Invoices?.[0]?.LineItems?.[0]?.Description).toBe('Solar Panel Leads');
    expect(body.Invoices?.[0]?.LineItems?.[0]?.Quantity).toBe(40);
    expect(body.Invoices?.[0]?.LineItems?.[0]?.UnitAmount).toBe(12.5);
    // VAT-registered client → line gets OUTPUT2 tax code
    expect(body.Invoices?.[0]?.LineItems?.[0]?.TaxType).toBe('OUTPUT2');
  });

  it('is a no-op when the invoice already has a xeroInvoiceId', async () => {
    // Pre-stamp the invoice as already pushed.
    await db.update(invoices).set({ xeroInvoiceId: 'already-pushed-id' }).where(eq(invoices.id, invoiceId));

    let fetchCalled = false;
    global.fetch = (async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/v1/invoices/${invoiceId}/push-to-xero`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.invoice.xeroInvoiceId).toBe('already-pushed-id');
    expect(fetchCalled).toBe(false);
  });

  it('surfaces a 502 when Xero returns an error', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/connect/token')) {
        return {
          ok: true, status: 200, headers: new Headers(), json: async () => ({ access_token: 't', expires_in: 1800 }), text: async () => '',
        } as unknown as Response;
      }
      if (String(url).endsWith('/connections')) {
        return {
          ok: true, status: 200, headers: new Headers(), json: async () => [{ tenantId: 't', tenantName: 'x' }], text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: false, status: 400, headers: new Headers(),
        json: async () => ({ error: 'ValidationException' }),
        text: async () => '{"error":"ValidationException"}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/v1/invoices/${invoiceId}/push-to-xero`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/xero push failed/i);
  });
});
