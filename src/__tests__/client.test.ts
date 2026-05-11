import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;
let realClientId: string; // UUID of an existing DB client — used in detail / update / credit tests
let realCompanyName: string; // Company name of that client — used in search test
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Client API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Create a dedicated client for ID-specific tests (detail / update /
    // credit). Must have a companyNumber so runCreditCheck works — the
    // Endole provider needs it. Self-contained so we don't depend on
    // pre-seeded DB state.
    const createRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Test Co ${Date.now()}`,
        companyNumber: '00445790',
        contactName: 'Test Contact',
        contactEmail: 'contact@test.co',
        currency: 'GBP',
      });
    realClientId = createRes.body.data.client.id;
    realCompanyName = createRes.body.data.client.companyName;
  });

  describe('GET /api/v1/clients', () => {
    it('owner can list clients', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
    });

    it('client role cannot list clients', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/v1/clients?status=active').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.clients.forEach((c: any) => expect(c.status).toBe('active'));
    });

    it('filters by search', async () => {
      const term = realCompanyName.split(' ')[0].toLowerCase();
      const res = await request(app).get(`/api/v1/clients?search=${encodeURIComponent(term)}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/clients/:id', () => {
    it('returns client detail', async () => {
      const res = await request(app).get(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.companyName).toBe(realCompanyName);
      expect(res.body.data.client.billingWorkflow).toBeDefined();
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).get(`/api/v1/clients/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/clients', () => {
    it('creates a new client', async () => {
      const res = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`).send({
        companyName: 'Test Corp',
        contactName: 'Test User',
        contactEmail: 'test@testcorp.com',
        currency: 'GBP',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.client.companyName).toBe('Test Corp');
      expect(res.body.data.client.status).toBe('prospect');
    });

    // Sam asked for credit checks to auto-trigger on buyer creation so staff
    // never forget. Fire-and-forget — the create response returns immediately,
    // the score lands within a few seconds via the credit-checks table.
    it('auto-triggers a credit check when companyNumber is provided', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `AutoCheck Co ${Date.now()}`,
          companyNumber: '00445790',
          contactName: 'Auto Check',
          contactEmail: 'auto@check.co',
          currency: 'GBP',
        });
      expect(createRes.status).toBe(201);
      const newId = createRes.body.data.client.id;

      // Poll up to 5s for the auto-triggered credit check to land.
      let history: unknown[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .get(`/api/v1/clients/${newId}/credit-history`)
          .set('Authorization', `Bearer ${ownerToken}`);
        history = res.body.data.history;
        if (history.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(history.length).toBeGreaterThan(0);
    });

    // Slice 1 Day 1: clients now store structured address (line/town/county/
    // country/postcode) and VAT details (number + rate) so the agreement
    // template auto-fill flow (Sam's Loom #57-67) has the data it needs.
    it('persists split address fields + VAT details on create', async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Addr Co ${Date.now()}`,
          contactName: 'Addr Contact',
          contactEmail: 'addr@co.test',
          currency: 'GBP',
          addressLine: '10 Fleet Street',
          addressTown: 'London',
          addressCounty: 'Greater London',
          addressCountry: 'United Kingdom',
          addressPostcode: 'EC4Y 1AA',
          vatRegistered: true,
          vatNumber: 'GB123456789',
          vatRate: 20,
        });
      expect(res.status).toBe(201);
      const c = res.body.data.client;
      expect(c.addressLine).toBe('10 Fleet Street');
      expect(c.addressTown).toBe('London');
      expect(c.addressCounty).toBe('Greater London');
      expect(c.addressCountry).toBe('United Kingdom');
      expect(c.addressPostcode).toBe('EC4Y 1AA');
      expect(c.vatRegistered).toBe(true);
      expect(c.vatNumber).toBe('GB123456789');
      expect(c.vatRate).toBe(20);
    });

    it('updates split address fields + VAT details via PUT', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Update Addr ${Date.now()}`,
          contactName: 'Update Addr',
          contactEmail: 'update@addr.test',
        });
      const id = createRes.body.data.client.id;
      const res = await request(app)
        .put(`/api/v1/clients/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          addressLine: '1 Test Lane',
          addressPostcode: 'W1A 1AA',
          vatNumber: 'GB999999999',
          vatRate: 17.5,
        });
      expect(res.status).toBe(200);
      expect(res.body.data.client.addressLine).toBe('1 Test Lane');
      expect(res.body.data.client.addressPostcode).toBe('W1A 1AA');
      expect(res.body.data.client.vatNumber).toBe('GB999999999');
      expect(res.body.data.client.vatRate).toBe(17.5);
    });

    // Slice 1 Day 2: client_contacts table backs the "multiple contacts per
    // client" UI (primary / billing / compliance / other). Sam's Loom #17.
    it('persists multiple contacts on create', async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Multi Contact ${Date.now()}`,
          companyNumber: '00445790',
          contacts: [
            { contactType: 'primary', name: 'Jamie Roberts', email: 'jamie@uken.co.uk', phone: '+44 20 1234 5678', role: 'National Sales Director' },
            { contactType: 'billing', name: 'Sarah Books', email: 'sarah@uken.co.uk', phone: '', role: 'Accounts Manager' },
            { contactType: 'compliance', name: 'Tom Audit', email: 'tom@uken.co.uk', phone: '', role: 'Compliance Officer' },
          ],
        });
      expect(res.status).toBe(201);
      const c = res.body.data.client;
      expect(c.contacts).toHaveLength(3);
      const primary = c.contacts.find((x: { contactType: string }) => x.contactType === 'primary');
      expect(primary.name).toBe('Jamie Roberts');
      expect(primary.role).toBe('National Sales Director');
      // Legacy contact_name/email/phone mirrored from primary for back-compat
      expect(c.contactName).toBe('Jamie Roberts');
      expect(c.contactEmail).toBe('jamie@uken.co.uk');
    });

    it('auto-generates a primary contact from legacy contactName when no contacts[] provided', async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Legacy Contact ${Date.now()}`,
          contactName: 'Alice Old',
          contactEmail: 'alice@old.test',
          contactPhone: '+44 1234 567890',
        });
      expect(res.status).toBe(201);
      const c = res.body.data.client;
      expect(c.contacts).toHaveLength(1);
      expect(c.contacts[0].contactType).toBe('primary');
      expect(c.contacts[0].name).toBe('Alice Old');
      expect(c.contacts[0].email).toBe('alice@old.test');
    });

    it('replaces contacts on update via PUT', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Update Contacts ${Date.now()}`,
          contacts: [{ contactType: 'primary', name: 'V1 Primary', email: 'v1@test.co' }],
        });
      const id = createRes.body.data.client.id;
      const res = await request(app)
        .put(`/api/v1/clients/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          contacts: [
            { contactType: 'primary', name: 'V2 Primary', email: 'v2@test.co' },
            { contactType: 'billing', name: 'V2 Billing', email: 'billing@test.co' },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.client.contacts).toHaveLength(2);
      const names = res.body.data.client.contacts.map((c: { name: string }) => c.name).sort();
      expect(names).toEqual(['V2 Billing', 'V2 Primary']);
    });

    it('returns contacts on GET /clients/:id', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Get Contacts ${Date.now()}`,
          contacts: [{ contactType: 'primary', name: 'Get Test', email: 'get@test.co' }],
        });
      const id = createRes.body.data.client.id;
      const res = await request(app)
        .get(`/api/v1/clients/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.contacts).toHaveLength(1);
      expect(res.body.data.client.contacts[0].contactType).toBe('primary');
    });

    it('defaults VAT rate to 20 when not provided', async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Default VAT ${Date.now()}`,
          contactName: 'Default',
          contactEmail: 'default@vat.test',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.client.vatRate).toBe(20);
    });

    it('does NOT auto-trigger a credit check when companyNumber is missing', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `NoNumber Co ${Date.now()}`,
          contactName: 'No Number',
          contactEmail: 'no@number.co',
          currency: 'GBP',
        });
      expect(createRes.status).toBe(201);
      const newId = createRes.body.data.client.id;

      // Wait briefly to confirm nothing fires in background.
      await new Promise((r) => setTimeout(r, 800));
      const res = await request(app)
        .get(`/api/v1/clients/${newId}/credit-history`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.data.history).toHaveLength(0);
    });
  });

  describe('PUT /api/v1/clients/:id', () => {
    it('updates a client', async () => {
      const res = await request(app).put(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`).send({
        notes: 'Updated via test',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.client.notes).toBe('Updated via test');
    });
  });

  describe('GET /api/v1/clients/:id/credit-history', () => {
    it('returns credit history (may be empty before any check has run)', async () => {
      const res = await request(app).get(`/api/v1/clients/${realClientId}/credit-history`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.history)).toBe(true);
    });
  });

  describe('POST /api/v1/clients/:id/credit-check', () => {
    it('runs a credit check', async () => {
      const res = await request(app).post(`/api/v1/clients/${realClientId}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.creditCheck.creditScore).toBeDefined();
      expect(res.body.data.creditCheck.riskRating).toBeDefined();
    });

    it('persists endoleCompanyId on the client row after a successful check', async () => {
      // Run a check to ensure the column gets populated, then read the client
      // back. The External System IDs card on the client detail page reads
      // this column, so a regression here would make the card show
      // "Not linked" forever even after running checks (pre-fix behaviour).
      await request(app).post(`/api/v1/clients/${realClientId}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      const res = await request(app).get(`/api/v1/clients/${realClientId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.client.endoleCompanyId).toBe('00445790');
    });

    it('returns 404 for non-existent client', async () => {
      const res = await request(app).post(`/api/v1/clients/${MISSING_UUID}/credit-check`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  // Slice 1 Day 5: sync-invoices-from-Xero — Sam Loom #32.
  // Xero is not configured in the test env (no XERO_CLIENT_ID), so the
  // service short-circuits with a "not configured" result. Tests verify
  // the routing + scoping + response shape, not the real Xero round-trip
  // (xero-client.test.ts already covers that with fetch mocks).
  describe('sync invoices from Xero', () => {
    let syncClientId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Sync Client ${Date.now()}`,
          contactName: 'Sync Owner',
          contactEmail: 'sync@owner.test',
        });
      syncClientId = res.body.data.client.id;
    });

    it('returns 0 synced + message when Xero is unreachable or the contact is missing', async () => {
      // In CI the Xero env vars may or may not be set:
      //  - unset → service short-circuits with "Xero not configured"
      //  - set but invalid → findContactByName throws, caught + falls through
      //    to "Couldn't find <name> in Xero. Create the contact in Xero first..."
      // Either way the externally-observable contract is: 200 OK + synced=0 +
      // a non-empty message. The real round-trip is covered by xero-client tests.
      const res = await request(app)
        .post(`/api/v1/clients/${syncClientId}/sync-invoices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.synced).toBe(0);
      expect(typeof res.body.data.message).toBe('string');
      expect(res.body.data.message.length).toBeGreaterThan(0);
    });

    it('returns 404 for missing client', async () => {
      const res = await request(app)
        .post(`/api/v1/clients/${MISSING_UUID}/sync-invoices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects client-role users', async () => {
      const res = await request(app)
        .post(`/api/v1/clients/${syncClientId}/sync-invoices`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  // Slice 1 Day 4: per-client invoices endpoint — Sam Loom #30.
  describe('client invoices', () => {
    it('returns empty list when client has no invoices', async () => {
      const createRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Inv Empty ${Date.now()}`,
          contactName: 'Inv Owner',
          contactEmail: 'inv@empty.test',
        });
      const id = createRes.body.data.client.id;
      const res = await request(app)
        .get(`/api/v1/clients/${id}/invoices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoices).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('returns 404 for missing client', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${MISSING_UUID}/invoices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects client-role users', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${realClientId}/invoices`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('lists invoices scoped to the client (and only that client)', async () => {
      // Create two clients + invoices on each, verify isolation.
      const aRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ companyName: `Inv A ${Date.now()}`, contactName: 'A', contactEmail: 'a@a.test' });
      const bRes = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ companyName: `Inv B ${Date.now()}`, contactName: 'B', contactEmail: 'b@b.test' });
      const aId = aRes.body.data.client.id;
      const bId = bRes.body.data.client.id;

      const lineItems = [{ description: 'Test', quantity: 1, unitPrice: 100, amount: 100 }];
      await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: aId, currency: 'GBP', lineItems, addVat: false });
      await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: bId, currency: 'GBP', lineItems, addVat: false });

      const aList = await request(app)
        .get(`/api/v1/clients/${aId}/invoices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(aList.status).toBe(200);
      expect(aList.body.data.invoices.length).toBe(1);
      expect(aList.body.data.invoices[0].clientId).toBe(aId);
    });
  });

  // Slice 1 Day 3: client documents replaced localStorage (Sam Loom #36).
  // File bytes live in R2; this table tracks the metadata. We don't hit R2
  // in these tests — we just verify the metadata CRUD works.
  describe('client documents', () => {
    let docClientId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/clients')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          companyName: `Doc Client ${Date.now()}`,
          contactName: 'Doc Owner',
          contactEmail: 'doc@owner.test',
        });
      docClientId = res.body.data.client.id;
    });

    it('returns empty list initially', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.documents).toEqual([]);
    });

    it('adds a document record', async () => {
      const res = await request(app)
        .post(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          r2Key: '1778500000000-due-diligence.pdf',
          folder: 'misc',
          name: 'due-diligence.pdf',
          contentType: 'application/pdf',
          sizeBytes: 24576,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.document.r2Key).toBe('1778500000000-due-diligence.pdf');
      expect(res.body.data.document.name).toBe('due-diligence.pdf');
      expect(res.body.data.document.sizeBytes).toBe(24576);
      expect(res.body.data.document.uploadedBy).toBeTruthy();
    });

    it('lists added documents in reverse-chronological order', async () => {
      await request(app)
        .post(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ r2Key: 'k2', name: 'agreement.pdf', contentType: 'application/pdf', sizeBytes: 1024 });
      const res = await request(app)
        .get(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.documents.length).toBeGreaterThanOrEqual(2);
      // Newest first
      expect(res.body.data.documents[0].name).toBe('agreement.pdf');
    });

    it('removes a document', async () => {
      const createRes = await request(app)
        .post(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ r2Key: 'kill', name: 'kill.pdf' });
      const docId = createRes.body.data.document.id;
      const delRes = await request(app)
        .delete(`/api/v1/clients/${docClientId}/documents/${docId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(delRes.status).toBe(204);

      const listRes = await request(app)
        .get(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const ids = listRes.body.data.documents.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(docId);
    });

    it('returns 404 for missing client', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${MISSING_UUID}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects client-role users from viewing documents', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${docClientId}/documents`)
        .set('Authorization', `Bearer ${clientToken}`);
      // Client role is excluded by requireRole('owner','finance_admin','ops_manager') on clientRoutes.
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/clients/credit-alerts', () => {
    it('returns credit alerts', async () => {
      const res = await request(app).get('/api/v1/clients/credit-alerts').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.alerts).toBeDefined();
    });
  });
});
