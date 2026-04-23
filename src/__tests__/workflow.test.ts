import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let clientToken: string;
let seededWorkflowId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Workflow API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    // Seed a workflow with multi-step config so detail/execute tests have real data.
    const seedRes = await request(app).post('/api/v1/workflows').set('Authorization', `Bearer ${ownerToken}`).send({
      name: `Auto-Invoice ${Date.now()}`,
      description: 'Pulls last 7 days lead data and creates invoice in Xero.',
      type: 'scheduled',
      schedule: 'Every Monday 9:00 AM',
      steps: [
        { name: 'Pull LeadByte Data', type: 'data_fetch', config: 'last 7 days' },
        { name: 'Calculate totals', type: 'computation', config: 'sum × leadPrice' },
        { name: 'Create Xero Invoice', type: 'api_call', config: 'POST /Invoices DRAFT' },
      ],
    });
    seededWorkflowId = seedRes.body.data.workflow.id;
  });

  describe('GET /api/v1/workflows', () => {
    it('owner can list workflows', async () => {
      const res = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workflows.length).toBeGreaterThan(0);
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
      expect(wf.status).toBeDefined();
      expect(typeof wf.totalRuns).toBe('number');
      expect(typeof wf.successRate).toBe('number');
    });
  });

  describe('GET /api/v1/workflows/:id', () => {
    it('returns workflow detail with steps', async () => {
      const res = await request(app).get(`/api/v1/workflows/${seededWorkflowId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workflow.steps.length).toBe(3);
      expect(res.body.data.workflow.recentExecutions).toBeDefined();
      expect(res.body.data.workflow.steps[0].name).toBeDefined();
      expect(res.body.data.workflow.steps[0].type).toBeDefined();
    });

    it('returns 404 for non-existent workflow', async () => {
      const res = await request(app).get(`/api/v1/workflows/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
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
      const res = await request(app).post(`/api/v1/workflows/${seededWorkflowId}/toggle-status`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(['active', 'paused']).toContain(res.body.data.workflow.status);

      // Toggle back so subsequent tests aren't affected.
      await request(app).post(`/api/v1/workflows/${seededWorkflowId}/toggle-status`).set('Authorization', `Bearer ${ownerToken}`);
    });
  });

  describe('POST /api/v1/workflows/:id/execute', () => {
    it('executes a workflow', async () => {
      const res = await request(app).post(`/api/v1/workflows/${seededWorkflowId}/execute`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      // With Redis available the run is enqueued and reported as `running`.
      // Without Redis the synchronous fallback records `completed` immediately.
      expect(['running', 'completed']).toContain(res.body.data.execution.status);
      expect(res.body.data.execution.result).toBeDefined();
    });

    it('returns 404 for non-existent workflow', async () => {
      const res = await request(app).post(`/api/v1/workflows/${MISSING_UUID}/execute`).set('Authorization', `Bearer ${ownerToken}`);
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
