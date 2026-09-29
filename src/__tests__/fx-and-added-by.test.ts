import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { fxRates } from '../db/schema/fx-rates.js';
import {
  parseFrankfurter, parseEcbXml, fetchLatestRates, convertTotalsToGbp, getRate, storeSnapshot,
} from '../services/fx.service.js';

// Feedback round 1 (Sam, 29 Sep 2026):
//   M3  — add amounts only after converting to £, and say so (rate + date).
//   S14 — "filters (currency, country, owner)": who added each client.

// Recorded response shapes (Frankfurter /latest?from=GBP, ECB eurofxref-daily).
const FRANKFURTER = { amount: 1, base: 'GBP', date: '2026-09-28', rates: { EUR: 1.1628, PLN: 4.9612, CHF: 1.0732, USD: 1.3401 } };
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='2026-09-28'>
    <Cube currency='USD' rate='1.1525'/><Cube currency='GBP' rate='0.86000'/><Cube currency='PLN' rate='4.2666'/><Cube currency='CHF' rate='0.9229'/>
  </Cube></Cube></gesmes:Envelope>`;

const TEST_DATE = '1999-01-04'; // far in the past: never collides with real rows
const tag = `fx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

describe('FX parsers', () => {
  it('parses Frankfurter (GBP base)', () => {
    const s = parseFrankfurter(FRANKFURTER);
    expect(s.rateDate).toBe('2026-09-28');
    expect(s.source).toMatch(/ECB/);
    expect(s.quotes.find((q) => q.quote === 'EUR')?.rate).toBe(1.1628);
  });

  it('rejects a Frankfurter body with the wrong base', () => {
    expect(() => parseFrankfurter({ ...FRANKFURTER, base: 'EUR' })).toThrow();
  });

  it('crosses ECB EUR-base rates to GBP base', () => {
    const s = parseEcbXml(ECB_XML);
    expect(s.rateDate).toBe('2026-09-28');
    const eur = s.quotes.find((q) => q.quote === 'EUR')!.rate;
    const pln = s.quotes.find((q) => q.quote === 'PLN')!.rate;
    expect(eur).toBeCloseTo(1 / 0.86, 6); // 1 GBP = 1.1628 EUR
    expect(pln).toBeCloseTo(4.2666 / 0.86, 6);
    expect(s.quotes.some((q) => q.quote === 'GBP')).toBe(false);
  });

  it('falls back to the ECB XML when Frankfurter fails', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.includes('frankfurter')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => ECB_XML };
    };
    const s = await fetchLatestRates(fake);
    expect(s.source).toBe('ECB');
    expect(calls).toHaveLength(2);
  });
});

describe('convertTotalsToGbp', () => {
  beforeAll(async () => {
    await db.delete(fxRates).where(eq(fxRates.rateDate, TEST_DATE));
  });
  afterAll(async () => {
    await db.delete(fxRates).where(eq(fxRates.rateDate, TEST_DATE));
  });

  it('returns null when only GBP is present (nothing converted)', async () => {
    expect(await convertTotalsToGbp([{ currency: 'GBP', total: 100 }])).toBeNull();
  });

  it('returns null (never a partial sum) when a currency has no rate', async () => {
    expect(await convertTotalsToGbp([{ currency: 'GBP', total: 100 }, { currency: 'XTS', total: 5 }])).toBeNull();
  });

  it('converts at the latest rate on/before the date and reports it', async () => {
    await storeSnapshot({ rateDate: TEST_DATE, source: 'test', quotes: [{ quote: 'EUR', rate: 1.25 }] });
    const r = await getRate('EUR', '1999-01-05');
    expect(r).toMatchObject({ currency: 'EUR', rate: 1.25, rateDate: TEST_DATE, source: 'test' });
    expect(await getRate('EUR', '1999-01-03')).toBeNull(); // nothing before the first rate
  });
});

describe('Feedback M3 — /invoices/outstanding convertedTotalGbp', () => {
  let ownerToken: string;
  const createdClientIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  let today: string;

  beforeAll(async () => {
    ownerToken = (await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' })).body.data.tokens.accessToken;
    today = new Date().toISOString().slice(0, 10);
    await db.delete(fxRates).where(and(eq(fxRates.rateDate, today), eq(fxRates.source, 'test-fx')));
    await storeSnapshot({ rateDate: today, source: 'test-fx', quotes: [{ quote: 'EUR', rate: 1.2 }] });
    const [eur] = await db.insert(clients).values({ businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test FX EUR ${tag}`, currency: 'EUR', status: 'active' }).returning();
    const [gbp] = await db.insert(clients).values({ businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test FX GBP ${tag}`, currency: 'GBP', status: 'active' }).returning();
    createdClientIds.push(eur.id, gbp.id);
    for (const [cid, cur, total] of [[eur.id, 'EUR', '1200.00'], [gbp.id, 'GBP', '500.00']] as const) {
      const [inv] = await db.insert(invoices).values({
        clientId: cid, invoiceNumber: `INV-${tag}-${cur}`, status: 'authorised', currency: cur, total,
        dueDate: new Date(Date.now() + 5 * 86_400_000), xeroInvoiceId: `xero-${tag}-${cur}`,
      }).returning();
      createdInvoiceIds.push(inv.id);
    }
  });

  afterAll(async () => {
    if (createdInvoiceIds.length) await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    if (createdClientIds.length) await db.delete(clients).where(inArray(clients.id, createdClientIds));
    await db.delete(fxRates).where(and(eq(fxRates.rateDate, today), eq(fxRates.source, 'test-fx')));
  });

  it('adds a converted GBP total with the rate and date, keeping per-currency totals', async () => {
    const res = await request(app).get('/api/v1/invoices/outstanding?bucket=all').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totalsByCurrency.map((t: { currency: string }) => t.currency)).toEqual(expect.arrayContaining(['EUR', 'GBP']));
    const conv = d.convertedTotalGbp;
    expect(conv).not.toBeNull();
    expect(conv.rates).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'EUR', rate: 1.2, rateDate: today })]));
    // Every part is converted at its own rate; the sum equals the parts.
    const eurPart = conv.parts.find((p: { currency: string }) => p.currency === 'EUR');
    const eurTotal = Number(d.totalsByCurrency.find((t: { currency: string }) => t.currency === 'EUR').total);
    expect(eurPart.gbp).toBeCloseTo(eurTotal / 1.2, 2);
    const sum = conv.parts.reduce((s: number, p: { gbp: number }) => s + p.gbp, 0);
    expect(conv.amount).toBeCloseTo(sum, 2);
  });
});

describe('Feedback S14 — "Added by"', () => {
  let ownerToken: string;
  let ownerId: string;
  let createdId: string;
  let legacyId: string;

  beforeAll(async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = login.body.data.tokens.accessToken;
    ownerId = login.body.data.user.id;
    const res = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`)
      .send({ companyName: `Yash Test AddedBy ${tag}`, addressCountry: 'United Kingdom' });
    createdId = res.body.data.client.id;
    const [legacy] = await db.insert(clients).values({ businessId: LEADGEN_BUSINESS_ID, companyName: `Yash Test Legacy ${tag}` }).returning();
    legacyId = legacy.id;
  });

  afterAll(async () => {
    await db.delete(clients).where(inArray(clients.id, [createdId, legacyId].filter(Boolean)));
  });

  it('records who created the client', async () => {
    const [row] = await db.select().from(clients).where(eq(clients.id, createdId));
    expect(row.createdBy).toBe(ownerId);
  });

  it('filters by the adder, and by Unknown for old rows', async () => {
    const mine = await request(app).get(`/api/v1/clients?addedBy=${ownerId}&search=${tag}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(mine.body.data.clients.map((c: { id: string }) => c.id)).toEqual([createdId]);
    expect(mine.body.data.clients[0].createdBy).toMatchObject({ id: ownerId });
    const unknown = await request(app).get(`/api/v1/clients?addedBy=unknown&search=${tag}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(unknown.body.data.clients.map((c: { id: string }) => c.id)).toEqual([legacyId]);
  });

  it('rejects a malformed addedBy', async () => {
    const res = await request(app).get('/api/v1/clients?addedBy=not-a-uuid').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it('lists the filter options incl. Unknown', async () => {
    const res = await request(app).get('/api/v1/clients/added-by-options').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.options.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([ownerId, 'unknown']));
  });

  it('includes "Added by" in the CSV', async () => {
    const res = await request(app).get(`/api/v1/clients/export.csv?search=${tag}&sort=company&dir=asc`).set('Authorization', `Bearer ${ownerToken}`);
    const lines = res.text.replace(/^﻿/, '').trim().split(/\r\n/);
    const header = lines[0]!.split(',');
    const col = header.indexOf('Added by');
    expect(col).toBeGreaterThan(-1);
    const legacyLine = lines.find((l) => l.includes('Legacy'))!;
    expect(legacyLine.split(',')[col]).toBe('Unknown');
  });
});
