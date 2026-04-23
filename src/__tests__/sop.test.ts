import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let seededSopId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('SOP API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    // Self-seed two SOPs so list/filter tests have something to find.
    const seed1 = await request(app).post('/api/v1/sops').set('Authorization', `Bearer ${ownerToken}`).send({
      title: `Onboarding Procedure ${Date.now()}`,
      content: 'Steps for onboarding a new client end to end.',
      category: 'Onboarding',
      status: 'published',
    });
    seededSopId = seed1.body.data.sop.id;

    await request(app).post('/api/v1/sops').set('Authorization', `Bearer ${ownerToken}`).send({
      title: `Finance Review ${Date.now()}`,
      content: 'Weekly invoice batch review steps.',
      category: 'Finance',
      status: 'published',
    });
  });

  describe('GET /api/v1/sops', () => {
    it('returns list of SOPs with expected fields', async () => {
      const res = await request(app).get('/api/v1/sops').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.sops.length).toBeGreaterThan(0);
      const sop = res.body.data.sops[0];
      expect(sop.id).toBeDefined();
      expect(sop.title).toBeDefined();
      expect(sop.category).toBeDefined();
      expect(sop.version).toBeDefined();
      expect(sop.author).toBeDefined();
      expect(sop.lastUpdated).toBeDefined();
      expect(sop.status).toBeDefined();
    });

    it('filters by category', async () => {
      const res = await request(app).get('/api/v1/sops?category=Finance').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.sops.length).toBeGreaterThan(0);
      res.body.data.sops.forEach((s: any) => expect(s.category).toBe('Finance'));
    });

    it('search works', async () => {
      const res = await request(app).get('/api/v1/sops?search=onboarding').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.sops.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/sops/:id', () => {
    it('returns SOP detail with content', async () => {
      const res = await request(app).get(`/api/v1/sops/${seededSopId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.sop.id).toBe(seededSopId);
      expect(res.body.data.sop.content.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent SOP', async () => {
      const res = await request(app).get(`/api/v1/sops/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/sops', () => {
    it('creates a new SOP', async () => {
      const newSop = {
        title: 'Test SOP Procedure',
        content: 'This is a test SOP with detailed steps.',
        category: 'Operations',
        status: 'draft',
      };
      const res = await request(app).post('/api/v1/sops').set('Authorization', `Bearer ${ownerToken}`).send(newSop);
      expect(res.status).toBe(201);
      expect(res.body.data.sop.title).toBe(newSop.title);
      expect(res.body.data.sop.content).toBe(newSop.content);
      expect(res.body.data.sop.category).toBe(newSop.category);
      expect(res.body.data.sop.status).toBe('draft');
      expect(res.body.data.sop.version).toBe('1.0');
    });
  });

  describe('PUT /api/v1/sops/:id', () => {
    it('updates an existing SOP', async () => {
      const update = { title: 'Updated SOP Title' };
      const res = await request(app).put(`/api/v1/sops/${seededSopId}`).set('Authorization', `Bearer ${ownerToken}`).send(update);
      expect(res.status).toBe(200);
      expect(res.body.data.sop.title).toBe('Updated SOP Title');
    });
  });

  describe('Unauthenticated access', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/sops');
      expect(res.status).toBe(401);
    });
  });
});
