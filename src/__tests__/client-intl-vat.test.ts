// Sam feedback 2026-09-29 — M5 (non-UK clients), S3 (activity log logs only
// real changes), S4 (VAT treatment), N7 (trim contact names), M7 (New Invoice
// follows the client).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientActivityLog } from '../db/schema/client-activity.js';
import {
  isPlausiblePhone, isPlausiblePostcode, deriveVatTreatment, vatFlagsFor, isUkCountry,
} from '../utils/client-locale.js';
import { dueDateFromTerms } from '../services/invoice.service.js';

let ownerToken: string;
const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

async function createClient(body: Record<string, unknown>) {
  return request(app).post('/api/v1/clients').set(auth()).send({
    companyName: `Intl Test ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...body,
  });
}

async function latestUpdateEvent(clientId: string) {
  const [row] = await db
    .select()
    .from(clientActivityLog)
    .where(and(eq(clientActivityLog.clientId, clientId), eq(clientActivityLog.eventType, 'client_updated')))
    .orderBy(desc(clientActivityLog.createdAt))
    .limit(1);
  return row;
}

describe('client-locale helpers', () => {
  it('rejects obvious junk phones and accepts international numbers', () => {
    expect(isPlausiblePhone('not-a-phone ###')).toBe(false);
    expect(isPlausiblePhone('123')).toBe(false);
    expect(isPlausiblePhone('+41 44 668 18 00')).toBe(true);
    expect(isPlausiblePhone('+48 22 123 45 67')).toBe(true);
    expect(isPlausiblePhone('020 7946 0958')).toBe(true);
    expect(isPlausiblePhone('')).toBe(true);
  });

  it('rejects junk postcodes and accepts local formats', () => {
    expect(isPlausiblePostcode('!!!!!!!!')).toBe(false);
    expect(isPlausiblePostcode('8001')).toBe(true);        // CH
    expect(isPlausiblePostcode('00-950')).toBe(true);      // PL
    expect(isPlausiblePostcode('D02 X285')).toBe(true);    // IE Eircode
    expect(isPlausiblePostcode('EC4Y 1AA')).toBe(true);    // UK
    expect(isPlausiblePostcode('')).toBe(true);
  });

  it('derives a treatment from the legacy flags exactly as invoices behaved before', () => {
    expect(deriveVatTreatment(null, true, true)).toBe('uk_standard');
    expect(deriveVatTreatment(null, false, true)).toBe('uk_zero_rated');
    expect(deriveVatTreatment(null, false, false)).toBe('outside_scope');
    expect(deriveVatTreatment('reverse_charge', true, true)).toBe('reverse_charge');
    expect(deriveVatTreatment('garbage', false, false)).toBe('outside_scope');
    expect(vatFlagsFor('reverse_charge')).toEqual({ vatRegistered: true, addVatToInvoices: false });
  });

  it('treats unset / UK spellings as UK only', () => {
    expect(isUkCountry('United Kingdom')).toBe(true);
    expect(isUkCountry('')).toBe(true);
    expect(isUkCountry('Switzerland')).toBe(false);
    expect(isUkCountry('Poland')).toBe(false);
  });

  it('due date is today + terms (UTC date)', () => {
    const from = new Date('2026-09-29T15:00:00Z');
    expect(dueDateFromTerms(4, from).toISOString().slice(0, 10)).toBe('2026-10-03');
    expect(dueDateFromTerms(null, from).toISOString().slice(0, 10)).toBe('2026-10-29');
  });
});

describe('Client API — international setup', () => {
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;
  });

  it('refuses a junk phone and postcode with a clear message', async () => {
    const res = await createClient({
      addressCountry: 'Switzerland',
      addressPostcode: '!!!!!!!!',
      contactPhone: 'not-a-phone ###',
    });
    expect(res.status).toBe(400);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain('body.addressPostcode');
    expect(paths).toContain('body.contactPhone');
  });

  it('refuses a junk phone on a contact row', async () => {
    const res = await createClient({
      contacts: [{ contactType: 'primary', name: 'Yash Test', email: 'yash.test@example.com', phone: 'not-a-phone ###' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('body.contacts.0.phone');
  });

  it('saves a Swiss CHF reverse-charge client and keeps the legacy flags consistent', async () => {
    const res = await createClient({
      addressCountry: 'Switzerland',
      addressPostcode: '8001',
      contactPhone: '+41 44 668 18 00',
      currency: 'CHF',
      companyNumber: 'CHE-123.456.789',
      vatTreatment: 'reverse_charge',
    });
    expect(res.status).toBe(201);
    const c = res.body.data.client;
    expect(c.currency).toBe('CHF');
    expect(c.vatTreatment).toBe('reverse_charge');
    expect(c.vatRegistered).toBe(true);
    expect(c.addVatToInvoices).toBe(false);
  });

  it('a legacy caller sending only vatRegistered still gets VAT added (uk_standard)', async () => {
    const res = await createClient({ vatRegistered: true, currency: 'GBP' });
    expect(res.status).toBe(201);
    expect(res.body.data.client.vatTreatment).toBe('uk_standard');
    expect(res.body.data.client.addVatToInvoices).toBe(true);
  });

  it('N7 — trims company, contact names and emails', async () => {
    const res = await createClient({
      contactName: 'Daniel ',
      contacts: [{ contactType: 'primary', name: '  Clode  ', email: ' clode@example.com ', phone: '' }],
    });
    expect(res.status).toBe(201);
    const c = res.body.data.client;
    expect(c.contactName).toBe('Daniel');
    expect(c.contacts[0].name).toBe('Clode');
    expect(c.contacts[0].email).toBe('clode@example.com');
  });

  it('S3 — logs only fields that actually changed, with old → new', async () => {
    const created = await createClient({
      currency: 'GBP',
      paymentTermsDays: 30,
      vatRate: 20,
      contacts: [{ contactType: 'primary', name: 'Yash Test', email: 'yash.test@example.com', phone: '' }],
    });
    const id = created.body.data.client.id;

    // Re-send every field unchanged + one real change (the old FE shape).
    const res = await request(app).put(`/api/v1/clients/${id}`).set(auth()).send({
      companyName: created.body.data.client.companyName,
      currency: 'GBP',
      paymentTermsDays: 4,
      vatRate: '20.00',
      vatTreatment: 'outside_scope',
      contacts: [{ contactType: 'primary', name: 'Yash Test', email: 'yash.test@example.com', phone: '' }],
    });
    expect(res.status).toBe(200);
    const ev = await latestUpdateEvent(id);
    const payload = ev?.payload as { changed: string[]; diff: Record<string, { from: unknown; to: unknown }>; contactsReplaced: boolean };
    expect(payload.changed).toEqual(['paymentTermsDays']);
    expect(payload.diff.paymentTermsDays).toEqual({ from: 30, to: 4 });
    expect(payload.contactsReplaced).toBe(false);
  });

  it('S3 — a Save with nothing changed writes no activity event', async () => {
    const created = await createClient({ currency: 'EUR' });
    const id = created.body.data.client.id;
    await request(app).put(`/api/v1/clients/${id}`).set(auth()).send({ currency: 'EUR' });
    expect(await latestUpdateEvent(id)).toBeUndefined();
  });

  it('S4 — switching treatment updates both legacy flags', async () => {
    const created = await createClient({ vatTreatment: 'uk_standard' });
    const id = created.body.data.client.id;
    const res = await request(app).put(`/api/v1/clients/${id}`).set(auth()).send({ vatTreatment: 'outside_scope' });
    expect(res.body.data.client.vatTreatment).toBe('outside_scope');
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row.vatRegistered).toBe(false);
    expect(row.addVatToInvoices).toBe(false);
    expect(row.vatTreatment).toBe('outside_scope');
  });
});

describe('Invoice API — New Invoice follows the client (M7)', () => {
  let gbpClientId: string;
  let eurOnboardingId: string;
  const lineItems = [{ description: 'Yash test leads', quantity: 1, unitPrice: 100 }];

  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = res.body.data.tokens.accessToken;
    // "Copious"-shaped: GBP, 4-day terms, not VAT registered, Active.
    const gbp = await createClient({ currency: 'GBP', paymentTermsDays: 4, vatTreatment: 'outside_scope', status: 'active' });
    gbpClientId = gbp.body.data.client.id;
    // "Sonova"-shaped: EUR, still Onboarding.
    const eur = await createClient({ currency: 'EUR', paymentTermsDays: 30, vatTreatment: 'reverse_charge' });
    eurOnboardingId = eur.body.data.client.id;
  });

  it('lists onboarding clients as billable, with terms and treatment', async () => {
    const res = await request(app).get('/api/v1/invoices/clients').set(auth());
    const eur = res.body.data.clients.find((c: { id: string }) => c.id === eurOnboardingId);
    expect(eur).toBeDefined();
    expect(eur.status).toBe('onboarding');
    expect(eur.currency).toBe('EUR');
    expect(eur.vatTreatment).toBe('reverse_charge');
    expect(eur.paymentTermsDays).toBe(30);
  });

  it('leaves churned clients out', async () => {
    const churned = await createClient({ status: 'churned' });
    const res = await request(app).get('/api/v1/invoices/clients').set(auth());
    expect(res.body.data.clients.some((c: { id: string }) => c.id === churned.body.data.client.id)).toBe(false);
  });

  it('refuses a currency that differs from the client unless confirmed', async () => {
    const res = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: gbpClientId, currency: 'EUR', addVat: false, lineItems });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('currency_mismatch');
    expect(res.body.message).toMatch(/billed in GBP/);

    const ok = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: gbpClientId, currency: 'EUR', addVat: false, lineItems, confirmCurrencyMismatch: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.invoice.currency).toBe('EUR');
  });

  it('defaults the due date to today + the client payment terms', async () => {
    const res = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: gbpClientId, currency: 'GBP', addVat: false, lineItems });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.dueDate.slice(0, 10)).toBe(dueDateFromTerms(4).toISOString().slice(0, 10));
  });

  it('honours an explicit due date', async () => {
    const res = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: gbpClientId, currency: 'GBP', addVat: false, lineItems, dueDate: '2026-12-01' });
    expect(res.body.data.invoice.dueDate.slice(0, 10)).toBe('2026-12-01');
  });

  it('refuses VAT for a client whose treatment is not UK VAT', async () => {
    const res = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: eurOnboardingId, currency: 'EUR', addVat: true, lineItems });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('vat_not_applicable');
  });

  it("charges the client's own VAT rate, not a hard-coded 20%", async () => {
    const c = await createClient({ currency: 'GBP', vatTreatment: 'uk_standard', vatRate: 5 });
    const res = await request(app).post('/api/v1/invoices').set(auth())
      .send({ clientId: c.body.data.client.id, currency: 'GBP', addVat: true, lineItems });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.invoice.vatAmount)).toBe(5);
    expect(Number(res.body.data.invoice.total)).toBe(105);
  });
});
