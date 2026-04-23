import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let financeToken: string;
let clientToken: string;
let realClientId: string; // UUID of a DB client used for invoice creation
let realInvoiceId: string; // UUID of the invoice we create in beforeAll
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Invoice API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const finRes = await request(app).post('/api/v1/auth/login').send({ email: 'finance@stato.app', password: 'finance123' });
    financeToken = finRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Make sure at least one active client exists (service filters by status='active'
    // for the invoice dropdown). Create a dedicated one.
    const createClient = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Invoice Test Client ${Date.now()}`,
        companyNumber: '00445790',
        contactEmail: 'billing@test.example',
        currency: 'GBP',
        vatRegistered: true,
      });
    realClientId = createClient.body.data.client.id;

    // Client starts as 'prospect' — invoice dropdown only shows 'active'.
    // Activate it for the dropdown test to find it.
    await request(app)
      .put(`/api/v1/clients/${realClientId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'active' });

    // Create an invoice we can use for detail + push-to-xero tests.
    const createInv = await request(app)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientId: realClientId,
        currency: 'GBP',
        addVat: true,
        lineItems: [{ description: 'Setup charges', quantity: 10, unitPrice: 20, amount: 200 }],
      });
    realInvoiceId = createInv.body.data.invoice.id;
  });

  describe('GET /api/v1/invoices', () => {
    it('owner can list invoices', async () => {
      const res = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoices.length).toBeGreaterThan(0);
    });

    it('finance_admin can list invoices', async () => {
      const res = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${financeToken}`);
      expect(res.status).toBe(200);
    });

    it('client cannot list invoices', async () => {
      const res = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/v1/invoices?status=paid').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.invoices.forEach((inv: { status: string }) => expect(inv.status).toBe('paid'));
    });
  });

  describe('GET /api/v1/invoices/overdue', () => {
    it('returns overdue invoices only', async () => {
      const res = await request(app).get('/api/v1/invoices/overdue').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.invoices.forEach((inv: { status: string }) => expect(inv.status).toBe('overdue'));
    });
  });

  describe('GET /api/v1/invoices/clients', () => {
    it('returns active clients for invoice creation', async () => {
      const res = await request(app).get('/api/v1/invoices/clients').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.clients.length).toBeGreaterThan(0);
      expect(res.body.data.clients[0].id).toBeDefined();
      expect(res.body.data.clients[0].name).toBeDefined();
      expect(res.body.data.clients[0].vatRegistered).toBeDefined();
    });
  });

  describe('GET /api/v1/invoices/:id', () => {
    it('returns invoice detail with line items', async () => {
      const res = await request(app).get(`/api/v1/invoices/${realInvoiceId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoice.lineItems).toBeDefined();
      expect(res.body.data.invoice.lineItems.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await request(app).get(`/api/v1/invoices/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/invoices', () => {
    it('creates a new invoice', async () => {
      const res = await request(app).post('/api/v1/invoices').set('Authorization', `Bearer ${ownerToken}`).send({
        clientId: realClientId,
        currency: 'GBP',
        addVat: true,
        lineItems: [{ description: 'Test Leads', quantity: 50, unitPrice: 10, amount: 500 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.invoice.invoiceNumber).toBeDefined();
      expect(res.body.data.invoice.total).toBeGreaterThan(0);
      expect(res.body.data.invoice.status).toBe('draft');
    });
  });

  describe('POST /api/v1/invoices/:id/push-to-xero', () => {
    it('returns 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post(`/api/v1/invoices/${MISSING_UUID}/push-to-xero`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    // Note: the happy-path "actually pushes to Xero" case is exercised by the
    // service-level tests with a mocked fetch. Hitting the real Xero API from
    // an automated test suite would create test invoices in Sam's live books.
  });
});
