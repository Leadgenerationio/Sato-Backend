import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let financeToken: string;
let financeCurrentPassword = 'finance123';

describe('Profile & Password API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const financeRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'finance@stato.app', password: financeCurrentPassword });
    financeToken = financeRes.body.data.tokens.accessToken;
  });

  describe('PATCH /api/v1/auth/me', () => {
    it('updates the authenticated user name', async () => {
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Sam Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.name).toBe('Sam Updated');

      // Restore
      await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Sam Owner' });
    });

    it('rejects empty name', async () => {
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: '' });

      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).patch('/api/v1/auth/me').send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/auth/change-password', () => {
    it('rejects incorrect current password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${financeToken}`)
        .send({ currentPassword: 'wrong', newPassword: 'new-pw-xyz' });

      expect(res.status).toBe(401);
    });

    it('rejects too-short new password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${financeToken}`)
        .send({ currentPassword: financeCurrentPassword, newPassword: 'abc' });

      expect(res.status).toBe(400);
    });

    it('changes password and allows login with new password', async () => {
      const newPw = 'finance-new-pw';
      const changeRes = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${financeToken}`)
        .send({ currentPassword: financeCurrentPassword, newPassword: newPw });

      expect(changeRes.status).toBe(200);

      // Old password no longer works
      const oldLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'finance@stato.app', password: financeCurrentPassword });
      expect(oldLogin.status).toBe(401);

      // New password works
      const newLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'finance@stato.app', password: newPw });
      expect(newLogin.status).toBe(200);

      // Restore so other tests keep working
      const newToken = newLogin.body.data.tokens.accessToken;
      await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${newToken}`)
        .send({ currentPassword: newPw, newPassword: financeCurrentPassword });
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: 'x', newPassword: 'yyyyyy' });

      expect(res.status).toBe(401);
    });
  });
});

describe('Permission matrix owner-lock', () => {
  it('rejects attempts to change owner-role permissions', async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    const token = ownerRes.body.data.tokens.accessToken;

    const res = await request(app)
      .patch('/api/v1/permissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ permission: 'Manage Users', role: 'owner', allowed: false });

    expect(res.status).toBe(403);
  });
});
