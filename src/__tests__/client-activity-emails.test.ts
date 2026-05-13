import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// L #33 (email thread) + L #38 (activity feed). One test file because
// the two features share a backing table pattern and reinforce each
// other — every email log emits an activity event.

let ownerToken: string;
let clientToken: string;
let clientId: string;

describe('Client activity feed + email thread', () => {
  beforeAll(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clRes.body.data.tokens.accessToken;

    const createRes = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        companyName: `Activity Test Co ${Date.now()}`,
        contactName: 'Test',
        contactEmail: 'test@example.com',
        currency: 'GBP',
      });
    clientId = createRes.body.data.client.id;
  });

  describe('GET /clients/:id/activity', () => {
    it('returns the client_created event from setup', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const events = res.body.data.activity;
      expect(Array.isArray(events)).toBe(true);
      // We created this client in beforeAll, so at least one client_created
      // event must be present.
      expect(events.some((e: { eventType: string }) => e.eventType === 'client_created')).toBe(true);
    });

    it('respects limit query param', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/activity?limit=1`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.activity.length).toBeLessThanOrEqual(1);
    });
  });

  describe('POST /clients/:id/emails (inbound log)', () => {
    let emailId: string;

    it('rejects unknown direction (400)', async () => {
      const res = await request(app)
        .post(`/api/v1/clients/${clientId}/emails`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ direction: 'sideways', subject: 'x' });
      expect(res.status).toBe(400);
    });

    it('logs an inbound email', async () => {
      const res = await request(app)
        .post(`/api/v1/clients/${clientId}/emails`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          direction: 'inbound',
          subject: 'Hi from a buyer',
          body: 'Quick question about lead volume',
          fromAddress: 'buyer@example.com',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.email.direction).toBe('inbound');
      expect(res.body.data.email.subject).toBe('Hi from a buyer');
      emailId = res.body.data.email.id;
    });

    it('emits an email_logged_inbound activity event', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const found = res.body.data.activity.find(
        (e: { eventType: string }) => e.eventType === 'email_logged_inbound',
      );
      expect(found).toBeDefined();
      expect((found.payload as { subject: string }).subject).toBe('Hi from a buyer');
    });

    it('GET /clients/:id/emails returns the inbound row', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/emails`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const inbound = res.body.data.emails.find((e: { id: string }) => e.id === emailId);
      expect(inbound).toBeDefined();
    });

    it('direction filter works', async () => {
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/emails?direction=inbound`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.emails.every((e: { direction: string }) => e.direction === 'inbound')).toBe(true);
    });

    it('DELETE removes the email + writes an email_removed event', async () => {
      const res = await request(app)
        .delete(`/api/v1/clients/${clientId}/emails/${emailId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);

      const activityRes = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(activityRes.body.data.activity.some((e: { eventType: string }) => e.eventType === 'email_removed')).toBe(true);
    });

    it('DELETE on unknown id returns 404', async () => {
      const res = await request(app)
        .delete(`/api/v1/clients/${clientId}/emails/00000000-0000-0000-0000-000000000000`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('client role is blocked from activity + emails', async () => {
      const activityRes = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${clientToken}`);
      // Either explicit 403 or scope-filter denial. Both are acceptable —
      // what we never want is 200 leaking another client's data.
      expect([403, 404]).toContain(activityRes.status);

      const emailsRes = await request(app)
        .get(`/api/v1/clients/${clientId}/emails`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect([403, 404]).toContain(emailsRes.status);
    });
  });

  describe('activity events emitted by other modules', () => {
    it('document_uploaded fires when a document is added', async () => {
      await request(app)
        .post(`/api/v1/clients/${clientId}/documents`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          r2Key: `test-${Date.now()}.pdf`,
          name: 'test.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        });

      const activityRes = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(activityRes.body.data.activity.some(
        (e: { eventType: string }) => e.eventType === 'document_uploaded',
      )).toBe(true);
    });

    it('client_updated fires when fields are patched', async () => {
      await request(app)
        .put(`/api/v1/clients/${clientId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ notes: 'Updated to verify activity event' });

      const activityRes = await request(app)
        .get(`/api/v1/clients/${clientId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(activityRes.body.data.activity.some(
        (e: { eventType: string }) => e.eventType === 'client_updated',
      )).toBe(true);
    });
  });
});
