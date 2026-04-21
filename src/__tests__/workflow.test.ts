import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;

describe('Workflow API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  describe('GET /api/v1/workflows', () => {
    it('owner can list workflows', async () => {
      const res = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workflows.length).toBe(3);
    });

    it('client cannot list workflows', async () => {
      const res = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });

    it('workflow summary has expected fields', async () => {
      const res = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${ownerToken}`);
      const wf = res.body.data.workflows[0];
      expect(wf.id).toBeDefined();
      expect(wf.name).toBeDefined();
      expect(wf.schedule).toBeDefined();
      expect(wf.status).toBeDefined();
      expect(wf.totalRuns).toBeDefined();
      expect(wf.successRate).toBeDefined();
    });
  });

  describe('GET /api/v1/workflows/:id', () => {
    it('returns workflow detail with steps and executions', async () => {
      const res = await request(app).get('/api/v1/workflows/wf-1').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workflow.steps.length).toBeGreaterThan(0);
      expect(res.body.data.workflow.recentExecutions.length).toBeGreaterThan(0);
      expect(res.body.data.workflow.steps[0].name).toBeDefined();
      expect(res.body.data.workflow.steps[0].type).toBeDefined();
    });

    it('returns 404 for non-existent workflow', async () => {
      const res = await request(app).get('/api/v1/workflows/wf-999').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/workflows', () => {
    it('creates a new workflow', async () => {
      const res = await request(app).post('/api/v1/workflows').set('Authorization', `Bearer ${ownerToken}`).send({
        name: 'Test Workflow',
        description: 'A test workflow',
        type: 'manual',
        schedule: null,
        steps: [
          { name: 'Step 1', type: 'data_fetch', config: 'Fetch data' },
          { name: 'Step 2', type: 'notification', config: 'Send alert' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.workflow.name).toBe('Test Workflow');
      expect(res.body.data.workflow.status).toBe('draft');
      expect(res.body.data.workflow.steps.length).toBe(2);
    });
  });

  describe('POST /api/v1/workflows/:id/toggle-status', () => {
    it('toggles workflow status', async () => {
      const res = await request(app).post('/api/v1/workflows/wf-1/toggle-status').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const newStatus = res.body.data.workflow.status;
      expect(['active', 'paused']).toContain(newStatus);

      // Toggle back
      await request(app).post('/api/v1/workflows/wf-1/toggle-status').set('Authorization', `Bearer ${ownerToken}`);
    });
  });

  describe('POST /api/v1/workflows/:id/execute', () => {
    it('executes a workflow (mock)', async () => {
      const res = await request(app).post('/api/v1/workflows/wf-1/execute').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.execution.status).toBe('completed');
      expect(res.body.data.execution.result).toBeDefined();
    });

    it('returns 404 for non-existent workflow', async () => {
      const res = await request(app).post('/api/v1/workflows/wf-999/execute').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/workflows/step-types', () => {
    it('returns available step types', async () => {
      const res = await request(app).get('/api/v1/workflows/step-types').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.types.length).toBeGreaterThan(0);
      expect(res.body.data.types).toContain('data_fetch');
      expect(res.body.data.types).toContain('notification');
    });
  });
});
