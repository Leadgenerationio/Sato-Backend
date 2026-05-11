import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// Slice 1 end-to-end. Walks the UK Energy Saving Network journey from create
// through contacts → VAT update → documents → invoices → sync. Mirror of
// slice2-e2e.test.ts but for Sam Loom #16-36 (clients side). If this passes,
// Slice 1's "ONE client fully processed" goal is verifiably solved.

let ownerToken: string;
let clientToken: string;
let clientId: string;
let primaryContactId: string;
let docId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Slice 1 E2E: UK Energy Saving Network', () => {
  beforeAll(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  it('Step 1 — creates a client with split address + VAT details + 3 contacts', async () => {
    const ts = Date.now();
    const res = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `UK Energy Saving Network ${ts}`,
        companyNumber: '12345678',
        addressLine: '10 Fleet Street',
        addressTown: 'London',
        addressCounty: 'Greater London',
        addressCountry: 'United Kingdom',
        addressPostcode: 'EC4Y 1AA',
        currency: 'GBP',
        billingWorkflow: 'weekly_auto',
        vatRegistered: true,
        vatNumber: 'GB123456789',
        vatRate: 20,
        contacts: [
          { contactType: 'primary', name: 'Jamie Roberts', email: 'jamie@uken.test', phone: '+44 20 1234 5678', role: 'National Sales Director' },
          { contactType: 'billing', name: 'Sarah Books', email: 'sarah@uken.test', role: 'Accounts Manager' },
          { contactType: 'compliance', name: 'Tom Audit', email: 'tom@uken.test', role: 'Compliance Officer' },
        ],
      });
    expect(res.status).toBe(201);
    const c = res.body.data.client;
    clientId = c.id;
    expect(c.addressLine).toBe('10 Fleet Street');
    expect(c.addressTown).toBe('London');
    expect(c.addressPostcode).toBe('EC4Y 1AA');
    expect(c.vatRegistered).toBe(true);
    expect(c.vatNumber).toBe('GB123456789');
    expect(c.vatRate).toBe(20);
    expect(c.contacts).toHaveLength(3);
    // Primary contact mirrored to legacy contact_name fields for back-compat.
    expect(c.contactName).toBe('Jamie Roberts');
    expect(c.contactEmail).toBe('jamie@uken.test');
    const primary = c.contacts.find((x: { contactType: string }) => x.contactType === 'primary');
    primaryContactId = primary.id;
  });

  it('Step 2 — GET /clients/:id returns the full shape', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const c = res.body.data.client;
    expect(c.addressCounty).toBe('Greater London');
    expect(c.addressCountry).toBe('United Kingdom');
    expect(c.contacts).toHaveLength(3);
    const types = c.contacts.map((x: { contactType: string }) => x.contactType).sort();
    expect(types).toEqual(['billing', 'compliance', 'primary']);
  });

  it('Step 3 — PATCH client to update VAT rate + replace contacts', async () => {
    const res = await request(app)
      .put(`/api/v1/clients/${clientId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        vatRate: 17.5,
        contacts: [
          { contactType: 'primary', name: 'Jamie Roberts', email: 'jamie@uken.test', role: 'CEO' },
          { contactType: 'billing', name: 'Sarah Books', email: 'sarah@uken.test', role: 'Accounts Manager' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.client.vatRate).toBe(17.5);
    expect(res.body.data.client.contacts).toHaveLength(2);
    const primary = res.body.data.client.contacts.find((x: { contactType: string }) => x.contactType === 'primary');
    expect(primary.role).toBe('CEO');
    // Different id from step 1 — replace, not merge.
    expect(primary.id).not.toBe(primaryContactId);
  });

  it('Step 4 — lists empty documents initially', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.documents).toEqual([]);
  });

  it('Step 5 — adds a document via POST', async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        r2Key: `1778500000000-due-diligence-${Date.now()}.pdf`,
        folder: 'misc',
        name: 'due-diligence.pdf',
        contentType: 'application/pdf',
        sizeBytes: 24576,
      });
    expect(res.status).toBe(201);
    docId = res.body.data.document.id;
    expect(res.body.data.document.uploadedBy).toBeTruthy();
  });

  it('Step 6 — lists the new document', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.documents.length).toBe(1);
    expect(res.body.data.documents[0].id).toBe(docId);
  });

  it('Step 7 — removes the document', async () => {
    const del = await request(app)
      .delete(`/api/v1/clients/${clientId}/documents/${docId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const list = await request(app)
      .get(`/api/v1/clients/${clientId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.data.documents).toEqual([]);
  });

  it('Step 8 — invoices tab returns empty list for a new client', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/invoices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('Step 9 — Sync from Xero short-circuits cleanly when nothing to import', async () => {
    // Same contract as slice2-e2e: 200 + synced=0 + non-empty message,
    // regardless of whether Xero env is set (auth-fail) or unset (skipped).
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/sync-invoices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.synced).toBe(0);
    expect(typeof res.body.data.message).toBe('string');
    expect(res.body.data.message.length).toBeGreaterThan(0);
  });

  it('Step 10 — client-role users can\'t see this client (RBAC)', async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  it('Step 11 — 404 for missing client on every Slice-1 endpoint', async () => {
    const expectsMissing = await Promise.all([
      request(app).get(`/api/v1/clients/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`),
      request(app).get(`/api/v1/clients/${MISSING_UUID}/documents`).set('Authorization', `Bearer ${ownerToken}`),
      request(app).get(`/api/v1/clients/${MISSING_UUID}/invoices`).set('Authorization', `Bearer ${ownerToken}`),
      request(app).post(`/api/v1/clients/${MISSING_UUID}/sync-invoices`).set('Authorization', `Bearer ${ownerToken}`),
    ]);
    for (const r of expectsMissing) expect(r.status).toBe(404);
  });
});
