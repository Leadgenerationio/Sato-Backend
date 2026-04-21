import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let financeToken: string;
let clientToken: string;

describe('Invoice API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const finRes = await request(app).post('/api/v1/auth/login').send({ email: 'finance@stato.app', password: 'finance123' });
    financeToken = finRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
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
      res.body.data.invoices.forEach((inv: any) => expect(inv.status).toBe('paid'));
    });
  });

  describe('GET /api/v1/invoices/overdue', () => {
    it('returns overdue invoices only', async () => {
      const res = await request(app).get('/api/v1/invoices/overdue').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      res.body.data.invoices.forEach((inv: any) => expect(inv.status).toBe('overdue'));
    });
  });

  describe('GET /api/v1/invoices/clients', () => {
    it('returns client list for invoice creation', async () => {
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
      const listRes = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${ownerToken}`);
      const invId = listRes.body.data.invoices[0].id;

      const res = await request(app).get(`/api/v1/invoices/${invId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoice.lineItems).toBeDefined();
      expect(res.body.data.invoice.lineItems.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await request(app).get('/api/v1/invoices/inv-999999').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/invoices', () => {
    it('creates a new invoice', async () => {
      const res = await request(app).post('/api/v1/invoices').set('Authorization', `Bearer ${ownerToken}`).send({
        clientId: 'c-1',
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
});
