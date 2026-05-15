import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

let ownerToken: string;
let seededTaskId: string;
let seededCommentTaskId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Task API', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    // Self-seed enough tasks to cover list / filter / pagination assertions.
    const baseTask = {
      assignee: 'Sam Owner',
      category: 'billing',
    };
    const seeds = [
      { ...baseTask, title: `Review Apex Media invoice ${Date.now()}`, priority: 'high', status: 'todo' },
      { ...baseTask, title: 'Chase Delta payment', priority: 'urgent', status: 'in_progress', assignee: 'Finance Admin' },
      { ...baseTask, title: 'Monthly credit review', priority: 'medium', status: 'completed' },
      { ...baseTask, title: 'Set up campaign for Brightfield', priority: 'medium', status: 'todo' },
      { ...baseTask, title: 'Quarterly invoice reconciliation', priority: 'low', status: 'completed' },
    ];
    const ids: string[] = [];
    for (const t of seeds) {
      const res = await request(app).post('/api/v1/tasks').set('Authorization', `Bearer ${ownerToken}`).send(t);
      ids.push(res.body.data.task.id);
    }
    seededTaskId = ids[3]; // for update tests
    seededCommentTaskId = ids[0]; // for comment tests
  });

  describe('GET /api/v1/tasks', () => {
    it('owner can list tasks', async () => {
      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBeGreaterThan(0);
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
      const res = await request(app).get('/api/v1/tasks?page=1&limit=2').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks.length).toBe(2);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(2);
      expect(res.body.data.total).toBeGreaterThan(2);

      const res2 = await request(app).get('/api/v1/tasks?page=2&limit=2').set('Authorization', `Bearer ${ownerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data.page).toBe(2);
      expect(res2.body.data.tasks[0].id).not.toBe(res.body.data.tasks[0].id);
    });
  });

  describe('GET /api/v1/tasks/:id', () => {
    it('returns task detail', async () => {
      const res = await request(app).get(`/api/v1/tasks/${seededCommentTaskId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.task.title).toContain('Review Apex Media invoice');
      expect(res.body.data.task.comments).toBeDefined();
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).get(`/api/v1/tasks/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`);
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
      const res = await request(app).put(`/api/v1/tasks/${seededTaskId}`).set('Authorization', `Bearer ${ownerToken}`).send({
        title: 'Updated campaign setup task',
        priority: 'high',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.task.title).toBe('Updated campaign setup task');
      expect(res.body.data.task.priority).toBe('high');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).put(`/api/v1/tasks/${MISSING_UUID}`).set('Authorization', `Bearer ${ownerToken}`).send({
        title: 'Does not exist',
      });
      expect(res.status).toBe(404);
    });
  });

  // Sam (2026-05-15 Loom) called out the missing delete button. The route
  // is a straight hard-delete with FK-cascade on subtasks/attachments/etc.
  // These tests use freshly-created rows so other tests' fixtures aren't
  // destroyed mid-suite.
  describe('DELETE /api/v1/tasks/:id', () => {
    it('hard-deletes a task for owner', async () => {
      const createRes = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: `Delete me ${Date.now()}`, assignee: 'Sam Owner', category: 'billing' });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.task.id as string;

      const delRes = await request(app)
        .delete(`/api/v1/tasks/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data).toMatchObject({ deleted: true });

      // The row really is gone — subsequent GET 404s.
      const getRes = await request(app)
        .get(`/api/v1/tasks/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .delete(`/api/v1/tasks/${MISSING_UUID}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/tasks/:id/status', () => {
    it('updates task status', async () => {
      const res = await request(app).patch(`/api/v1/tasks/${seededTaskId}/status`).set('Authorization', `Bearer ${ownerToken}`).send({
        status: 'in_progress',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.task.status).toBe('in_progress');
    });

    it('returns 400 when status missing', async () => {
      const res = await request(app).patch(`/api/v1/tasks/${seededTaskId}/status`).set('Authorization', `Bearer ${ownerToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).patch(`/api/v1/tasks/${MISSING_UUID}/status`).set('Authorization', `Bearer ${ownerToken}`).send({
        status: 'completed',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/tasks/:id/comments', () => {
    it('adds a comment to a task', async () => {
      const res = await request(app).post(`/api/v1/tasks/${seededCommentTaskId}/comments`).set('Authorization', `Bearer ${ownerToken}`).send({
        text: 'Test comment from owner',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.comment.text).toBe('Test comment from owner');
      expect(res.body.data.comment.author).toBe('owner@stato.app');
      expect(res.body.data.comment.taskId).toBe(seededCommentTaskId);
    });

    it('returns 400 when text missing', async () => {
      const res = await request(app).post(`/api/v1/tasks/${seededCommentTaskId}/comments`).set('Authorization', `Bearer ${ownerToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).post(`/api/v1/tasks/${MISSING_UUID}/comments`).set('Authorization', `Bearer ${ownerToken}`).send({
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
      expect(typeof stats.completed).toBe('number');
      expect(typeof stats.in_progress).toBe('number');
      expect(typeof stats.overdue).toBe('number');
      expect(stats.by_priority).toBeDefined();
    });
  });

  describe('GET /api/v1/tasks/templates', () => {
    it('returns task templates (may be empty in fresh DB)', async () => {
      const res = await request(app).get('/api/v1/tasks/templates').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.templates)).toBe(true);
    });
  });

  describe('Authentication', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/tasks');
      expect(res.status).toBe(401);
    });

    // Audit 2026-05-03: tasks are an internal ops surface — clients and
    // readonly users no longer have access. Verify the gate works.
    it('readonly is blocked from tasks (403)', async () => {
      const readonlyRes = await request(app).post('/api/v1/auth/login').send({ email: 'readonly@stato.app', password: 'readonly123' });
      const readonlyToken = readonlyRes.body.data.tokens.accessToken;
      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${readonlyToken}`);
      expect(res.status).toBe(403);
    });

    it('client is blocked from tasks (403)', async () => {
      const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
      const clientToken = clientRes.body.data.tokens.accessToken;
      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });
});
