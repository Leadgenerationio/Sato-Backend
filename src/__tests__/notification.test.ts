import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;

describe('Notification API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
  });

  describe('GET /api/v1/notifications', () => {
    it('returns notifications list with expected fields', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.notifications.length).toBeGreaterThan(0);
      expect(res.body.data.total).toBeGreaterThan(0);
      expect(res.body.data.page).toBe(1);

      const notification = res.body.data.notifications[0];
      expect(notification.id).toBeDefined();
      expect(notification.type).toBeDefined();
      expect(notification.title).toBeDefined();
      expect(notification.message).toBeDefined();
      expect(typeof notification.read).toBe('boolean');
      expect(notification.createdAt).toBeDefined();
    });

    it('returns only unread notifications when filter=unread', async () => {
      const res = await request(app).get('/api/v1/notifications?filter=unread').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.notifications.length).toBeGreaterThan(0);

      for (const notification of res.body.data.notifications) {
        expect(notification.read).toBe(false);
      }
    });
  });

  describe('PUT /api/v1/notifications/:id/read', () => {
    it('marks a notification as read', async () => {
      // Find an unread notification first
      const listRes = await request(app).get('/api/v1/notifications?filter=unread').set('Authorization', `Bearer ${ownerToken}`);
      const unread = listRes.body.data.notifications[0];
      expect(unread).toBeDefined();

      const res = await request(app).put(`/api/v1/notifications/${unread.id}/read`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.notification.id).toBe(unread.id);
      expect(res.body.data.notification.read).toBe(true);
    });

    it('returns 404 for non-existent notification', async () => {
      const res = await request(app).put('/api/v1/notifications/ntf-999/read').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v1/notifications/read-all', () => {
    it('marks all notifications as read', async () => {
      const res = await request(app).put('/api/v1/notifications/read-all').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.updated).toBeDefined();
      expect(typeof res.body.data.updated).toBe('number');

      // Verify all are now read
      const listRes = await request(app).get('/api/v1/notifications?filter=unread').set('Authorization', `Bearer ${ownerToken}`);
      expect(listRes.body.data.notifications.length).toBe(0);
    });
  });

  describe('Role access', () => {
    it('owner can access notifications', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Authentication', () => {
    it('unauthenticated request returns 401', async () => {
      const res = await request(app).get('/api/v1/notifications');
      expect(res.status).toBe(401);
    });

    it('unauthenticated mark-as-read returns 401', async () => {
      const res = await request(app).put('/api/v1/notifications/ntf-001/read');
      expect(res.status).toBe(401);
    });

    it('unauthenticated read-all returns 401', async () => {
      const res = await request(app).put('/api/v1/notifications/read-all');
      expect(res.status).toBe(401);
    });
  });
});
