import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;
const createdIds: string[] = [];

describe('Agreement Templates API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await request(app).delete(`/api/v1/agreement-templates/${id}`).set('Authorization', `Bearer ${ownerToken}`);
    }
  });

  describe('GET /agreement-templates', () => {
    it('owner can list (200 + array)', async () => {
      const res = await request(app).get('/api/v1/agreement-templates').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.templates)).toBe(true);
    });

    it('client role blocked (403)', async () => {
      const res = await request(app).get('/api/v1/agreement-templates').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /agreement-templates', () => {
    it('owner can create a minimal template', async () => {
      const res = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Test Template 1', pdfR2Key: 'agreements/test-template-1.pdf' });
      expect(res.status).toBe(201);
      expect(res.body.data.template.name).toBe('Test Template 1');
      expect(res.body.data.template.fieldLayout).toEqual([]);
      createdIds.push(res.body.data.template.id);
    });

    it('rejects missing name (400)', async () => {
      const res = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pdfR2Key: 'agreements/x.pdf' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid fieldLayout entry (xPct > 1) (400)', async () => {
      const res = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Bad Layout',
          pdfR2Key: 'agreements/x.pdf',
          fieldLayout: [{ id: 'f1', type: 'variable', variableKey: 'client.companyName', page: 0, xPct: 1.5, yPct: 0.1, widthPct: 0.3, heightPct: 0.05 }],
        });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /agreement-templates/:id', () => {
    it('owner can update fieldLayout', async () => {
      const created = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Layout Test', pdfR2Key: 'agreements/x.pdf' });
      createdIds.push(created.body.data.template.id);

      const res = await request(app)
        .put(`/api/v1/agreement-templates/${created.body.data.template.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          fieldLayout: [
            { id: 'f1', type: 'variable', variableKey: 'client.companyName', page: 0, xPct: 0.1, yPct: 0.2, widthPct: 0.3, heightPct: 0.04 },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.template.fieldLayout).toHaveLength(1);
      expect(res.body.data.template.fieldLayout[0].variableKey).toBe('client.companyName');
    });
  });

  describe('GET /agreement-templates/:id', () => {
    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .get('/api/v1/agreement-templates/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /agreement-templates/:id (soft-delete)', () => {
    it('archived template no longer appears in list', async () => {
      const created = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'To Archive', pdfR2Key: 'agreements/x.pdf' });
      const id = created.body.data.template.id;

      const del = await request(app).delete(`/api/v1/agreement-templates/${id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(del.status).toBe(204);

      const list = await request(app).get('/api/v1/agreement-templates').set('Authorization', `Bearer ${ownerToken}`);
      const ids = list.body.data.templates.map((t: { id: string }) => t.id);
      expect(ids).not.toContain(id);
    });
  });

  describe('POST /agreement-templates/:id/duplicate', () => {
    it('creates a copy with " (copy)" suffix and same fieldLayout', async () => {
      const layout = [{ id: 'f1', type: 'variable' as const, variableKey: 'client.companyName', page: 0, xPct: 0.1, yPct: 0.1, widthPct: 0.3, heightPct: 0.04 }];
      const src = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Dup Source', pdfR2Key: 'agreements/x.pdf', fieldLayout: layout });
      createdIds.push(src.body.data.template.id);

      const dup = await request(app)
        .post(`/api/v1/agreement-templates/${src.body.data.template.id}/duplicate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(dup.status).toBe(201);
      expect(dup.body.data.template.name).toBe('Dup Source (copy)');
      expect(dup.body.data.template.fieldLayout).toEqual(layout);
      createdIds.push(dup.body.data.template.id);
    });
  });

  describe('POST /agreement-templates/:id/preview', () => {
    it('returns 404 when template not found', async () => {
      const res = await request(app)
        .post('/api/v1/agreement-templates/00000000-0000-0000-0000-000000000000/preview')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
    });

    it('returns 404 when client not found (template exists)', async () => {
      const t = await request(app)
        .post('/api/v1/agreement-templates')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Preview no-client', pdfR2Key: 'agreements/x.pdf' });
      createdIds.push(t.body.data.template.id);

      const res = await request(app)
        .post(`/api/v1/agreement-templates/${t.body.data.template.id}/preview`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ clientId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
    });
  });
});
