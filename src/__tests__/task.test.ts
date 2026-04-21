import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;

describe('Task API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
  });

  describe('GET /api/v1/tasks', () => {
    it('owner can list tasks', async () => {
      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
      expect(res.body.data.total).toBeGreaterThanOrEqual(16);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/v1/tasks?status=completed').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
      res.body.data.tasks.forEach((t: any) => expect(t.status).toBe('completed'));
    });

    it('filters by priority', async () => {
      const res = await request(app).get('/api/v1/tasks?priority=urgent').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
      res.body.data.tasks.forEach((t: any) => expect(t.priority).toBe('urgent'));
    });

    it('filters by assignee', async () => {
      const res = await request(app).get('/api/v1/tasks?assignee=Finance').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
      res.body.data.tasks.forEach((t: any) => expect(t.assignee.toLowerCase()).toContain('finance'));
    });

    it('filters by search', async () => {
      const res = await request(app).get('/api/v1/tasks?search=invoice').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
    });

    it('pagination works', async () => {
      const res = await request(app).get('/api/v1/tasks?page=1&limit=3').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(3);
      expect(res.body.data.total).toBeGreaterThan(3);

      const res2 = await request(app).get('/api/v1/tasks?page=2&limit=3').set('Authorization', `Bearer ${ownerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data.tasks.length).toBe(3);
      expect(res2.body.data.page).toBe(2);
      // Ensure page 2 has different tasks than page 1
      expect(res2.body.data.tasks[0].id).not.toBe(res.body.data.tasks[0].id);
    });
  });

  describe('GET /api/v1/tasks/:id', () => {
    it('returns task detail', async () => {
      const res = await request(app).get('/api/v1/tasks/t-1').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.task.title).toBe('Review Apex Media invoice batch');
      expect(res.body.data.task.comments).toBeDefined();
      expect(res.body.data.task.comments.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).get('/api/v1/tasks/t-999').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/tasks', () => {
    it('creates a new task', async () => {
      const res = await request(app).post('/api/v1/tasks').set('Authorization', `Bearer ${ownerToken}`).send({
        title: 'Test task creation',
        description: 'A task created from tests',
        assignee: 'Sam Owner',
        priority: 'high',
        category: 'testing',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.task.title).toBe('Test task creation');
      expect(res.body.data.task.status).toBe('todo');
      expect(res.body.data.task.priority).toBe('high');
      expect(res.body.data.task.createdBy).toBe('owner@stato.app');
    });
  });

  describe('PUT /api/v1/tasks/:id', () => {
    it('updates a task', async () => {
      const res = await request(app).put('/api/v1/tasks/t-4').set('Authorization', `Bearer ${ownerToken}`).send({
        title: 'Updated campaign setup task',
        priority: 'high',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.task.title).toBe('Updated campaign setup task');
      expect(res.body.data.task.priority).toBe('high');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).put('/api/v1/tasks/t-999').set('Authorization', `Bearer ${ownerToken}`).send({
        title: 'Does not exist',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/tasks/:id/status', () => {
    it('updates task status', async () => {
      const res = await request(app).patch('/api/v1/tasks/t-4/status').set('Authorization', `Bearer ${ownerToken}`).send({
        status: 'in_progress',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.task.status).toBe('in_progress');
    });

    it('returns 400 when status missing', async () => {
      const res = await request(app).patch('/api/v1/tasks/t-4/status').set('Authorization', `Bearer ${ownerToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).patch('/api/v1/tasks/t-999/status').set('Authorization', `Bearer ${ownerToken}`).send({
        status: 'completed',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/tasks/:id/comments', () => {
    it('adds a comment to a task', async () => {
      const res = await request(app).post('/api/v1/tasks/t-1/comments').set('Authorization', `Bearer ${ownerToken}`).send({
        text: 'Test comment from owner',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.comment.text).toBe('Test comment from owner');
      expect(res.body.data.comment.author).toBe('owner@stato.app');
      expect(res.body.data.comment.taskId).toBe('t-1');
    });

    it('returns 400 when text missing', async () => {
      const res = await request(app).post('/api/v1/tasks/t-1/comments').set('Authorization', `Bearer ${ownerToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).post('/api/v1/tasks/t-999/comments').set('Authorization', `Bearer ${ownerToken}`).send({
        text: 'Should fail',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/tasks/stats', () => {
    it('returns task statistics', async () => {
      const res = await request(app).get('/api/v1/tasks/stats').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const { stats } = res.body.data;
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.completed).toBeGreaterThan(0);
      expect(stats.in_progress).toBeGreaterThan(0);
      expect(typeof stats.overdue).toBe('number');
      expect(stats.by_priority).toBeDefined();
      expect(stats.by_priority.low).toBeGreaterThanOrEqual(0);
      expect(stats.by_priority.medium).toBeGreaterThanOrEqual(0);
      expect(stats.by_priority.high).toBeGreaterThanOrEqual(0);
      expect(stats.by_priority.urgent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/v1/tasks/templates', () => {
    it('returns task templates', async () => {
      const res = await request(app).get('/api/v1/tasks/templates').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.templates.length).toBe(5);
      const template = res.body.data.templates[0];
      expect(template.name).toBeDefined();
      expect(template.steps).toBeDefined();
      expect(template.steps.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/tasks/templates/:id/create', () => {
    it('creates a task from template', async () => {
      const res = await request(app).post('/api/v1/tasks/templates/tmpl-1/create').set('Authorization', `Bearer ${ownerToken}`).send({
        assignee: 'Ops Manager',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.task.title).toBe('New Client Onboarding');
      expect(res.body.data.task.assignee).toBe('Ops Manager');
      expect(res.body.data.task.category).toBe('onboarding');
      expect(res.body.data.task.priority).toBe('high');
      expect(res.body.data.task.description).toContain('Steps:');
    });

    it('returns 404 for non-existent template', async () => {
      const res = await request(app).post('/api/v1/tasks/templates/tmpl-999/create').set('Authorization', `Bearer ${ownerToken}`).send({
        assignee: 'Someone',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/tasks');
      expect(res.status).toBe(401);
    });

    it('all roles can access tasks', async () => {
      // Login as readonly user — should still have access
      const readonlyRes = await request(app).post('/api/v1/auth/login').send({ email: 'readonly@stato.app', password: 'readonly123' });
      const readonlyToken = readonlyRes.body.data.tokens.accessToken;

      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${readonlyToken}`);
      expect(res.status).toBe(200);
    });
  });
});
