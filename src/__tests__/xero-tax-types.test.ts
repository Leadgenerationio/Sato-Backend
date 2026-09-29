/**
 * Sam feedback 2026-09-29 (S4): the Xero tax type per VAT treatment is an
 * Owner setting, and the invoice push to Xero uses it. Mocked fetch — no real
 * Xero calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { businessSettings } from '../db/schema/business-settings.js';
import * as xero from '../integrations/xero/xero-client.js';

const ORIGINAL_FETCH = global.fetch;
let ownerToken: string;
let financeToken: string;
let businessId: string;
const created: string[] = [];

async function login(email: string, password: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken as string;
}

function mockXero(calls: Array<{ url: string; init: RequestInit }>) {
  global.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const json = String(url).includes('/connect/token')
      ? { access_token: 'tok', expires_in: 1800 }
      : String(url).endsWith('/connections')
        ? [{ id: 'c', tenantId: 'tenant-abc', tenantName: 'Test Org' }]
        : { Invoices: [{ InvoiceID: `xero-${Date.now()}-${Math.random()}`, InvoiceNumber: 'INV-T' }] };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => json, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function pushedTaxType(vatTreatment: string, addVat: boolean): Promise<string> {
  const c = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`)
    .send({ companyName: `Tax Type ${vatTreatment} ${Date.now()}`, companyNumber: '00445790', currency: 'GBP', vatTreatment });
  const inv = await request(app).post('/api/v1/invoices').set('Authorization', `Bearer ${ownerToken}`)
    .send({ clientId: c.body.data.client.id, currency: 'GBP', addVat, lineItems: [{ description: 'Leads', quantity: 1, unitPrice: 100 }] });
  const id = inv.body.data.invoice.id as string;
  created.push(id);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  mockXero(calls);
  xero.__testing.resetCache();
  const res = await request(app).post(`/api/v1/invoices/${id}/push-to-xero`).set('Authorization', `Bearer ${ownerToken}`);
  expect(res.status).toBe(200);
  const call = calls.find((x) => x.url.includes('/api.xro/2.0/Invoices'));
  return JSON.parse(String(call!.init.body)).Invoices[0].LineItems[0].TaxType;
}

describe('Xero tax types per VAT treatment (S4)', () => {
  const savedEnv = { id: process.env.XERO_CLIENT_ID, secret: process.env.XERO_CLIENT_SECRET };
  beforeAll(async () => {
    // fetch is mocked; the push path only needs Xero to look configured.
    process.env.XERO_CLIENT_ID = 'test-client-id';
    process.env.XERO_CLIENT_SECRET = 'test-client-secret';
    ownerToken = await login('owner@stato.app', 'owner123');
    financeToken = await login('finance@stato.app', 'finance123');
    const me = await request(app).get('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`);
    expect(me.status).toBe(200);
    const payload = JSON.parse(Buffer.from(ownerToken.split('.')[1], 'base64url').toString());
    businessId = payload.businessId;
    await db.delete(businessSettings).where(eq(businessSettings.businessId, businessId));
  });

  afterEach(() => { global.fetch = ORIGINAL_FETCH; xero.__testing.resetCache(); });

  afterAll(async () => {
    process.env.XERO_CLIENT_ID = savedEnv.id;
    process.env.XERO_CLIENT_SECRET = savedEnv.secret;
    if (savedEnv.id === undefined) delete process.env.XERO_CLIENT_ID;
    if (savedEnv.secret === undefined) delete process.env.XERO_CLIENT_SECRET;
    for (const id of created) await db.delete(invoices).where(eq(invoices.id, id));
    await db.delete(businessSettings).where(eq(businessSettings.businessId, businessId));
  });

  it('returns today\'s behaviour as the defaults', async () => {
    const res = await request(app).get('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.body.data.taxTypes).toEqual({ uk_standard: 'OUTPUT2', uk_zero_rated: 'ZERORATEDOUTPUT', reverse_charge: 'NONE', outside_scope: 'NONE' });
  });

  it('is Owner only', async () => {
    const get = await request(app).get('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${financeToken}`);
    const put = await request(app).put('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${financeToken}`).send({ taxTypes: { reverse_charge: 'NONE' } });
    expect(get.status).toBe(403);
    expect(put.status).toBe(403);
  });

  it('refuses codes that are not Xero tax types, and unknown treatments', async () => {
    const bad = await request(app).put('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`).send({ taxTypes: { reverse_charge: 'not a code!' } });
    const unknown = await request(app).put('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`).send({ taxTypes: { export: 'NONE' } });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/isn't a valid Xero tax type/);
    expect(unknown.status).toBe(422);
  });

  it('saves a code, upper-cases it, and keeps the others', async () => {
    const put = await request(app).put('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`).send({ taxTypes: { reverse_charge: 'eczroutputservices' } });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`);
    expect(get.body.data.taxTypes.reverse_charge).toBe('ECZROUTPUTSERVICES');
    expect(get.body.data.taxTypes.uk_standard).toBe('OUTPUT2');
  });

  it('pushes each treatment with the configured code', async () => {
    await request(app).put('/api/v1/settings/xero-tax-types').set('Authorization', `Bearer ${ownerToken}`)
      .send({ taxTypes: { reverse_charge: 'ECZROUTPUTSERVICES', outside_scope: 'EXEMPTOUTPUT', uk_zero_rated: 'ZERORATEDOUTPUT' } });
    expect(await pushedTaxType('reverse_charge', false)).toBe('ECZROUTPUTSERVICES');
    expect(await pushedTaxType('outside_scope', false)).toBe('EXEMPTOUTPUT');
    expect(await pushedTaxType('uk_zero_rated', false)).toBe('ZERORATEDOUTPUT');
    expect(await pushedTaxType('uk_standard', true)).toBe('OUTPUT2');
    // A UK-standard client invoiced without VAT never gets a VAT code (M7).
    expect(await pushedTaxType('uk_standard', false)).toBe('NONE');
  });
});
