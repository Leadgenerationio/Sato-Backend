import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq, like, sql } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';

// Retest R2 (M5): a new client left without a company number failed with
// "Too small: expected string to have >=1 characters" — the form marks the
// field optional and sends "" when it is empty. Same body the form sends.
const TAG = `Yash Test Blank CN ${Date.now()}`;
let token = '';

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  token = res.body.data.tokens.accessToken;
});
afterAll(async () => {
  // Creating through the service also writes contacts, activity and (for UK numbers) credit checks.
  const mine = sql`(select id from clients where company_name like ${TAG + '%'})`;
  await db.execute(sql`delete from client_activity_log where client_id in ${mine}`);
  await db.execute(sql`delete from client_contacts where client_id in ${mine}`);
  await db.execute(sql`delete from credit_checks where client_id in ${mine}`);
  await db.execute(sql`delete from users where client_id in ${mine}`); // creating a client also creates its portal login
  await db.delete(clients).where(like(clients.companyName, `${TAG}%`));
});

const formBody = (name: string) => ({
  companyName: name, companyNumber: '', addressLine: '', addressTown: '', addressCounty: '', addressCountry: 'Switzerland',
  addressPostcode: '8001', currency: 'CHF', paymentTermsDays: 30, vatTreatment: 'reverse_charge', vatNumber: '', vatRate: 20,
  leadPrice: 0, billingWorkflow: 'weekly_auto', leadbyteClientId: '', endoleCompanyId: '', xeroContactId: '', notes: '',
  contacts: [{ contactType: 'primary', name: 'Yash Swiss Contact  ', email: 'yash.swiss@example.test', phone: '+41 44 123 45 67' }],
});

describe('client with no company number', () => {
  it('is created when the form sends an empty company number', async () => {
    const res = await request(app).post('/api/v1/clients').set({ Authorization: `Bearer ${token}` }).send(formBody(`${TAG} A`));
    expect(res.status).toBe(201);
    expect(res.body.data.client.companyNumber).toBe('');
    // N7 on a real save: the contact name typed with trailing spaces is stored trimmed.
    expect(res.body.data.client.contacts[0].name).toBe('Yash Swiss Contact');
    expect(res.body.data.client.contactName).toBe('Yash Swiss Contact');
  });

  it('can have its company number cleared on Edit', async () => {
    const created = await request(app).post('/api/v1/clients').set({ Authorization: `Bearer ${token}` }).send({ ...formBody(`${TAG} B`), companyNumber: 'CHE-123.456.789' });
    expect(created.status).toBe(201);
    const id = created.body.data.client.id;
    const res = await request(app).put(`/api/v1/clients/${id}`).set({ Authorization: `Bearer ${token}` }).send({ companyNumber: '' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row?.companyNumber).toBeNull();
  });

  it('still refuses a company number longer than the column', async () => {
    const res = await request(app).post('/api/v1/clients').set({ Authorization: `Bearer ${token}` }).send({ ...formBody(`${TAG} C`), companyNumber: 'X'.repeat(21) });
    expect(res.status).toBe(400);
  });
});
