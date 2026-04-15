import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

describe('API Integration', () => {
  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('logs in with valid credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: 'owner123' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.user.email).toBe('owner@stato.app');
      expect(res.body.data.tokens.accessToken).toBeDefined();
      expect(res.body.data.tokens.refreshToken).toBeDefined();
    });

    it('rejects invalid credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: 'wrongpassword' });

      expect(res.status).toBe(401);
    });

    it('validates email format', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: 'password' });

      expect(res.status).toBe(400);
    });

    it('requires password min length', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: '12345' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/auth/register', () => {
    it('registers a new user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'api-test@test.com', password: 'password123', name: 'API Test' });

      expect(res.status).toBe(201);
      expect(res.body.data.user.email).toBe('api-test@test.com');
      expect(res.body.data.tokens).toBeDefined();
    });

    it('rejects registration with missing name', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'no-name@test.com', password: 'password123' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns user for valid token', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: 'owner123' });

      const token = loginRes.body.data.tokens.accessToken;

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('owner@stato.app');
    });

    it('rejects without token', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('returns new tokens for valid refresh token', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: 'owner123' });

      const refreshToken = loginRes.body.data.tokens.refreshToken;

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.tokens.accessToken).toBeDefined();
      expect(res.body.data.tokens.refreshToken).toBeDefined();
    });
  });

  describe('GET /api/v1/users', () => {
    it('owner can list users', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'owner@stato.app', password: 'owner123' });

      const token = loginRes.body.data.tokens.accessToken;

      const res = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.users.length).toBeGreaterThanOrEqual(5);
    });

    it('non-owner cannot list users', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'readonly@stato.app', password: 'readonly123' });

      const token = loginRes.body.data.tokens.accessToken;

      const res = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('unauthenticated cannot list users', async () => {
      const res = await request(app).get('/api/v1/users');
      expect(res.status).toBe(401);
    });
  });
});
