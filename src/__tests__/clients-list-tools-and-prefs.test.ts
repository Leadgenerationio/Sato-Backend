import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { users } from '../db/schema/users.js';
import { csvCell, clientsToCsv, type ClientSummary } from '../services/client.service.js';
import { mergePreferences } from '../services/user.service.js';
import { splitBaseCurrency } from '../services/report.service.js';
import { formatMoney } from '../utils/currency.js';

// Feedback round 1 (Sam, 29 Sep 2026):
//   S14 — Clients list: no sorting, filters, page size or export.
//   N2  — preferences only saved in the browser.
//   S12 — Xero imports showed the import date as "Created"; P&L windowed
//         revenue by created_at; revenue figures summed across currencies.

const tag = `s14-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

let ownerToken: string;
let ownerUserId: string;
const createdClientIds: string[] = [];
const createdInvoiceIds: string[] = [];

function summary(over: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: 'x', companyName: 'Acme', contactName: 'Ann', contactEmail: 'a@acme.test', status: 'active',
    currency: 'GBP', creditScore: null, activeCampaigns: 0, totalRevenue: 0, revenueByCurrency: {},
    createdAt: '2026-09-29T10:00:00.000Z', agreementSigned: false, documentsCount: 0, ...over,
  };
}

describe('csvCell() / clientsToCsv()', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Sonova, sp. z o.o')).toBe('"Sonova, sp. z o.o"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+44 20')).toBe("'+44 20");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes revenue in the client currency and lists other currencies separately', () => {
    const csv = clientsToCsv([
      summary({ companyName: 'Sonova', currency: 'EUR', totalRevenue: 399791, revenueByCurrency: { EUR: 399791, GBP: 50 } }),
    ]);
    const [header, row] = csv.trim().split('\r\n');
    expect(header.split(',')).toContain('Revenue (own currency)');
    expect(row).toContain(',EUR,399791.00,GBP 50.00,');
  });
});

describe('mergePreferences()', () => {
  it('merges allow-listed keys without wiping others', () => {
    expect(mergePreferences({ dashboardLayout: ['a'] }, { campaignGrouping: 'vertical' }))
      .toEqual({ dashboardLayout: ['a'], campaignGrouping: 'vertical' });
  });
  it('removes a key sent as null', () => {
    expect(mergePreferences({ dashboardLayout: ['a'], taskFilters: { s: 1 } }, { taskFilters: null }))
      .toEqual({ dashboardLayout: ['a'] });
  });
  it('ignores keys outside the allow-list', () => {
    expect(mergePreferences({}, { role: 'owner' } as never)).toEqual({});
  });
});

describe('splitBaseCurrency()', () => {
  it('keeps GBP as the figure and never folds other currencies in', () => {
    expect(splitBaseCurrency([
      { currency: 'GBP', total: '100.50' },
      { currency: 'EUR', total: '34860' },
      { currency: null, total: '9.50' },
      { currency: 'CHF', total: '0' },
    ])).toEqual({ base: 110, others: [{ currency: 'EUR', total: 34860 }] });
  });
});

describe('formatMoney()', () => {
  it('uses the given currency, falling back to GBP on a malformed code', () => {
    expect(formatMoney(34860, 'EUR')).toBe('€34,860.00');
    expect(formatMoney('12.5', 'GBP')).toBe('£12.50');
    expect(formatMoney(5, '')).toBe('£5.00');
  });
});

async function makeClient(name: string, currency: string, extra: Partial<typeof clients.$inferInsert> = {}) {
  const [row] = await db
    .insert(clients)
    .values({ businessId: LEADGEN_BUSINESS_ID, companyName: `${name} ${tag}`, currency, status: 'active', ...extra })
    .returning();
  createdClientIds.push(row.id);
  return row.id;
}

async function makePaid(clientId: string, currency: string, total: string, extra: Partial<typeof invoices.$inferInsert> = {}) {
  const [row] = await db
    .insert(invoices)
    .values({ clientId, invoiceNumber: `INV-${tag}-${createdInvoiceIds.length}`, status: 'paid', currency, total, ...extra })
    .returning();
  createdInvoiceIds.push(row.id);
  return row.id;
}

describe('S14 / N2 / S12 — HTTP', () => {
  let aId: string; let bId: string; let cId: string;

  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    ownerUserId = ownerRes.body.data.user.id;

    // Revenue: B (GBP 500) > A (GBP 100) ; C is EUR with 9,999 EUR — which
    // must NOT outrank B, because own-currency sort compares like with like
    // only per client (C's own-currency figure is 9,999 EUR). We only assert
    // the GBP pair's order, which is well-defined.
    aId = await makeClient('Alpha', 'GBP', { addressCountry: 'United Kingdom', creditScore: 80 });
    bId = await makeClient('Bravo', 'GBP', { addressCountry: 'United Kingdom', creditScore: null });
    cId = await makeClient('Charlie', 'EUR', { addressCountry: 'Poland', creditScore: 40 });
    await makePaid(aId, 'GBP', '100.00');
    // Alpha's big EUR revenue must NOT lift it above Bravo on a GBP revenue
    // sort — own-currency only. Without this row the sort test can't tell.
    await makePaid(aId, 'EUR', '900000.00');
    await makePaid(bId, 'GBP', '500.00');
    await makePaid(bId, 'EUR', '100000.00'); // other-currency revenue must not affect B's GBP rank
    await makePaid(cId, 'EUR', '9999.00');
  });

  afterAll(async () => {
    if (createdInvoiceIds.length) await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    if (createdClientIds.length) await db.delete(clients).where(inArray(clients.id, createdClientIds));
    if (ownerUserId) await db.update(users).set({ preferences: null }).where(eq(users.id, ownerUserId));
  });

  const list = (qs: string) => request(app)
    .get(`/api/v1/clients?search=${encodeURIComponent(tag)}&${qs}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  const names = (res: request.Response) => res.body.data.clients.map((c: { companyName: string }) => c.companyName.split(' ')[0]);

  it('sorts by company both ways', async () => {
    expect(names(await list('sort=company&dir=asc'))).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(names(await list('sort=company&dir=desc'))).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by own-currency revenue (other-currency revenue does not count)', async () => {
    const gbpOnly = names(await list('sort=revenue&dir=desc&currency=GBP'));
    expect(gbpOnly).toEqual(['Bravo', 'Alpha']);
  });

  it('puts a missing credit score last in both directions', async () => {
    expect(names(await list('sort=credit&dir=desc'))).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(names(await list('sort=credit&dir=asc'))).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('filters by currency and by country (case-insensitive)', async () => {
    expect(names(await list('currency=eur'))).toEqual(['Charlie']);
    expect(names(await list('country=POLAND'))).toEqual(['Charlie']);
    expect(names(await list('country=pol'))).toEqual(['Charlie']);
    expect(names(await list('country=kingdom&sort=company&dir=asc'))).toEqual(['Alpha', 'Bravo']);
    // A LIKE wildcard typed by the user is literal, not "match everything".
    expect(names(await list('country=%25'))).toEqual([]);
  });

  it('rejects an unknown sort key instead of passing it to SQL', async () => {
    const res = await list('sort=company_name;drop table clients');
    expect(res.status).toBe(400);
  });

  it('GET /clients/export.csv returns the filtered, sorted list as CSV', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/export.csv?search=${encodeURIComponent(tag)}&sort=company&dir=desc`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['x-row-count']).toBe('3');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^Charlie /);
    expect(lines[3]).toMatch(/^Alpha /);
    expect(lines.find((l) => l.startsWith('Bravo'))).toContain(',GBP,500.00,EUR 100000.00,');
  });

  it('GET /clients/import/attio/status says whether Attio is configured', async () => {
    const res = await request(app).get('/api/v1/clients/import/attio/status').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(!!process.env.ATTIO_API_KEY);
  });

  it('N2: preferences round-trip, merge per key and reject unknown keys', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const put1 = await request(app).put('/api/v1/users/me/preferences').set(auth).send({ dashboardLayout: { order: ['bank', 'pnl'] } });
    expect(put1.status).toBe(200);
    await request(app).put('/api/v1/users/me/preferences').set(auth).send({ campaignGrouping: 'vertical' });
    const get = await request(app).get('/api/v1/users/me/preferences').set(auth);
    expect(get.body.data.preferences).toEqual({ dashboardLayout: { order: ['bank', 'pnl'] }, campaignGrouping: 'vertical' });

    const bad = await request(app).put('/api/v1/users/me/preferences').set(auth).send({ role: 'owner' });
    expect(bad.status).toBe(400);
  });

  it('N2: any signed-in role can use its own preferences (not owner-only)', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'readonly@stato.app', password: 'readonly123' });
    if (login.status !== 200) return; // readonly seed user absent in this DB
    const token = login.body.data.tokens.accessToken;
    const res = await request(app).get('/api/v1/users/me/preferences').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('S12: invoice list exposes the Xero invoice date separately from createdAt', async () => {
    const xeroDate = new Date('2025-07-01T00:00:00Z');
    const id = await makePaid(aId, 'GBP', '1.00', { invoiceDate: xeroDate, xeroInvoiceId: `xero-${tag}-d` });
    const res = await request(app)
      .get(`/api/v1/clients/${aId}/invoices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const inv = res.body.data.invoices.find((i: { id: string }) => i.id === id);
    expect(inv.invoiceDate).toBe(xeroDate.toISOString());
    expect(inv.createdAt).not.toBe(xeroDate.toISOString());
  });

  it('S12: P&L summary windows revenue by the invoice date, not the import date', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const before = await request(app).get('/api/v1/reports/pnl-summary?days=30').set(auth);
    // Imported today (created_at = now), but Xero dated it two years ago.
    await makePaid(aId, 'GBP', '777000.00', {
      invoiceDate: new Date(Date.now() - 730 * 86_400_000),
      dueDate: new Date(Date.now() - 700 * 86_400_000),
      xeroInvoiceId: `xero-${tag}-old`,
    });
    const after = await request(app).get('/api/v1/reports/pnl-summary?days=30').set(auth);
    expect(after.status).toBe(200);
    expect(Number(after.body.data.revenue)).toBe(Number(before.body.data.revenue));
  });

  it('S12/M3: dashboard + P&L revenue are GBP only; EUR is reported beside it, never added', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const statsBefore = await request(app).get('/api/v1/dashboard/stats').set(auth);
    const pnlBefore = await request(app).get('/api/v1/reports/pnl-summary?days=30').set(auth);
    const overviewBefore = await request(app).get('/api/v1/reports/financial-overview').set(auth);
    const recent = new Date(Date.now() - 2 * 86_400_000);
    await makePaid(cId, 'EUR', '34860.00', { invoiceDate: recent, dueDate: recent, xeroInvoiceId: `xero-${tag}-eur` });

    const stats = await request(app).get('/api/v1/dashboard/stats').set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.data.revenueCurrency).toBe('GBP');
    expect(stats.body.data.totalRevenue).toBe(statsBefore.body.data.totalRevenue);
    expect(stats.body.data.rollingRevenue90d).toBe(statsBefore.body.data.rollingRevenue90d);
    const eurStats = stats.body.data.otherCurrencyRevenue.find((o: { currency: string }) => o.currency === 'EUR');
    expect(eurStats.total).toBeGreaterThanOrEqual(34860);
    expect(stats.body.data.profitBasis).toEqual({ revenueDays: 90, costDays: 90, costSource: 'catchr_ad_spend' });

    const pnl = await request(app).get('/api/v1/reports/pnl-summary?days=30').set(auth);
    expect(pnl.body.data.revenue).toBe(pnlBefore.body.data.revenue);
    const eurPnl = pnl.body.data.otherCurrencyRevenue.find((o: { currency: string }) => o.currency === 'EUR');
    expect(eurPnl.total).toBeGreaterThanOrEqual(34860);

    const overview = await request(app).get('/api/v1/reports/financial-overview').set(auth);
    expect(overview.status).toBe(200);
    // Compare with the same report taken before this test's invoice, so EUR invoices already in the database (other tests, real
    // data in a shared test database) cannot change the answer: exactly one month gains exactly the new EUR, and no month's GBP
    // revenue moves.
    type Month = { revenue: number; otherCurrencyRevenue: Record<string, number> };
    const before: Month[] = overviewBefore.body.data.report;
    const after: Month[] = overview.body.data.report;
    expect(after.length).toBe(before.length);
    const eurGain = after.map((m, i) => (m.otherCurrencyRevenue?.EUR ?? 0) - (before[i]!.otherCurrencyRevenue?.EUR ?? 0));
    expect(eurGain.filter((g) => g !== 0)).toEqual([34860]);
    expect(after.map((m) => m.revenue)).toEqual(before.map((m) => m.revenue));
  });
});
