import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// Slice 5 Day 2 — subtasks / attachments / activity-feed CRUD plus the
// new task fields (time_block_minutes / linked_sop_id / parent_task_id /
// recurrence_cron / recurrence_next_run).

let ownerToken: string;
let clientToken: string;
let taskId: string;
let subtaskId: string;
let attachmentId: string;
const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

describe('Task Slice 5 — subtasks / attachments / activity', () => {
  beforeAll(async () => {
    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;

    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: `Slice 5 test task ${Date.now()}`,
        assignee: 'Sam Owner',
        priority: 'medium',
        // Slice 5 fields exercised on create:
        timeBlockMinutes: 60,
        recurrenceCron: '0 9 * * 1',  // every Monday 09:00
      });
    expect(createRes.status).toBe(201);
    taskId = createRes.body.data.task.id;
  });

  describe('new task fields', () => {
    it('round-trips timeBlockMinutes + recurrenceCron via GET /:id', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.task.timeBlockMinutes).toBe(60);
      expect(res.body.data.task.recurrenceCron).toBe('0 9 * * 1');
      expect(res.body.data.task.activity).toBeDefined();
      expect(Array.isArray(res.body.data.task.activity)).toBe(true);
    });

    it('PUT updates timeBlockMinutes + writes activity', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ timeBlockMinutes: 120 });
      expect(res.status).toBe(200);
      expect(res.body.data.task.timeBlockMinutes).toBe(120);
    });

    // ─── Slice 5 Day 7 — recurrence picker + auto-compute next_run ───
    it('PUT recurrenceCron auto-computes recurrenceNextRun when omitted', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ recurrenceCron: '0 9 * * *' });   // daily 09:00
      expect(res.status).toBe(200);
      expect(res.body.data.task.recurrenceCron).toBe('0 9 * * *');
      // Worker can never fire without a next-run timestamp; this is the
      // load-bearing assertion.
      const next = res.body.data.task.recurrenceNextRun;
      expect(next).toBeTruthy();
      expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
    });

    it('PUT recurrenceCron=null clears recurrenceNextRun too', async () => {
      // Ensure there's a cron + next_run first.
      await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ recurrenceCron: '0 9 * * *' });

      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ recurrenceCron: null });
      expect(res.status).toBe(200);
      expect(res.body.data.task.recurrenceCron).toBeNull();
      expect(res.body.data.task.recurrenceNextRun).toBeNull();
    });

    it('rejects invalid cron via zod', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ recurrenceCron: 'every monday at 9am' });
      expect(res.status).toBe(400);
    });

    it('createTask with cron auto-computes next_run', async () => {
      const res = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: `Recurring create ${Date.now()}`,
          assignee: 'Sam Owner',
          priority: 'low',
          recurrenceCron: '0 9 * * 1-5',  // weekdays 09:00
        });
      expect(res.status).toBe(201);
      expect(res.body.data.task.recurrenceCron).toBe('0 9 * * 1-5');
      expect(res.body.data.task.recurrenceNextRun).toBeTruthy();
    });

    // ─── Slice 5 Day 5 — parentTaskId, linkedSopId, children endpoint ───
    it('rejects negative timeBlockMinutes via zod', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ timeBlockMinutes: -1 });
      // zod chain validates int().positive() — request should fail at the edge.
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID linkedSopId via zod', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ linkedSopId: 'not-a-uuid' });
      expect(res.status).toBe(400);
    });

    it('PUT linkedSopId=null clears it', async () => {
      const res = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ linkedSopId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.task.linkedSopId).toBeNull();
    });

    it('parent task + child task round-trip via GET /:id/children', async () => {
      // Create a child pointing at our existing task as parent.
      const childRes = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: `Child task ${Date.now()}`,
          assignee: 'Sam Owner',
          priority: 'low',
          parentTaskId: taskId,
        });
      expect(childRes.status).toBe(201);
      expect(childRes.body.data.task.parentTaskId).toBe(taskId);

      // GET /:id/children should return the child task.
      const listRes = await request(app)
        .get(`/api/v1/tasks/${taskId}/children`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(listRes.status).toBe(200);
      const children = listRes.body.data.children;
      expect(Array.isArray(children)).toBe(true);
      const childIds = children.map((c: { id: string }) => c.id);
      expect(childIds).toContain(childRes.body.data.task.id);
    });

    it('children endpoint returns empty array for task with no children', async () => {
      const createRes = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: `Lonely task ${Date.now()}`, assignee: 'Bot', priority: 'low' });
      const lonelyId = createRes.body.data.task.id;

      const res = await request(app)
        .get(`/api/v1/tasks/${lonelyId}/children`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.children).toEqual([]);
    });

    it('client role is blocked from GET /:id/children', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/children`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('subtasks', () => {
    it('starts empty', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/subtasks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subtasks).toEqual([]);
    });

    it('creates a subtask with auto position', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${taskId}/subtasks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'Step 1 — gather assets' });
      expect(res.status).toBe(201);
      expect(res.body.data.subtask.title).toBe('Step 1 — gather assets');
      expect(res.body.data.subtask.isDone).toBe(false);
      expect(res.body.data.subtask.position).toBe(0);
      subtaskId = res.body.data.subtask.id;
    });

    it('PATCH isDone=true', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${taskId}/subtasks/${subtaskId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ isDone: true });
      expect(res.status).toBe(200);
      expect(res.body.data.subtask.isDone).toBe(true);
    });

    it('rejects invalid title via zod', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${taskId}/subtasks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: '' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown subtask on PATCH', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${taskId}/subtasks/${MISSING_UUID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ isDone: true });
      expect(res.status).toBe(404);
    });

    it('deletes a subtask', async () => {
      const del = await request(app)
        .delete(`/api/v1/tasks/${taskId}/subtasks/${subtaskId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(del.status).toBe(204);

      const list = await request(app)
        .get(`/api/v1/tasks/${taskId}/subtasks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const ids = list.body.data.subtasks.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(subtaskId);
    });
  });

  describe('attachments', () => {
    it('starts empty', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/attachments`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.attachments).toEqual([]);
    });

    it('records a new attachment after R2 upload', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${taskId}/attachments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          r2Key: `${Date.now()}-design-brief.pdf`,
          folder: 'misc',
          name: 'design-brief.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4096,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.attachment.name).toBe('design-brief.pdf');
      expect(res.body.data.attachment.uploadedBy).toBeTruthy();
      attachmentId = res.body.data.attachment.id;
    });

    it('lists the new attachment', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/attachments`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const ids = res.body.data.attachments.map((a: { id: string }) => a.id);
      expect(ids).toContain(attachmentId);
    });

    it('removes an attachment', async () => {
      const del = await request(app)
        .delete(`/api/v1/tasks/${taskId}/attachments/${attachmentId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(del.status).toBe(204);
    });
  });

  describe('activity feed', () => {
    it('captures every mutation type as a separate event', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const events = res.body.data.activity as Array<{ eventType: string }>;
      const types = new Set(events.map((e) => e.eventType));

      // From this test's actions: create + update + subtask add/complete/remove
      // + attachment add/remove. Plus the recurrence-set on create. All should
      // be present.
      expect(types.has('task_created')).toBe(true);
      expect(types.has('task_updated')).toBe(true);
      expect(types.has('subtask_added')).toBe(true);
      expect(types.has('subtask_completed')).toBe(true);
      expect(types.has('subtask_removed')).toBe(true);
      expect(types.has('attachment_added')).toBe(true);
      expect(types.has('attachment_removed')).toBe(true);
    });

    it('events are returned newest first', async () => {
      const res = await request(app)
        .get(`/api/v1/tasks/${taskId}/activity`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const events = res.body.data.activity as Array<{ createdAt: string }>;
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1].createdAt >= events[i].createdAt).toBe(true);
      }
    });
  });

  describe('RBAC + 404 sweep', () => {
    it('client role is blocked from all new endpoints', async () => {
      const r1 = await request(app)
        .get(`/api/v1/tasks/${taskId}/subtasks`)
        .set('Authorization', `Bearer ${clientToken}`);
      const r2 = await request(app)
        .get(`/api/v1/tasks/${taskId}/attachments`)
        .set('Authorization', `Bearer ${clientToken}`);
      const r3 = await request(app)
        .get(`/api/v1/tasks/${taskId}/activity`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
      expect(r3.status).toBe(403);
    });

    it('404 for unknown task on every Slice-5 endpoint', async () => {
      const responses = await Promise.all([
        request(app).get(`/api/v1/tasks/${MISSING_UUID}/subtasks`).set('Authorization', `Bearer ${ownerToken}`),
        request(app).post(`/api/v1/tasks/${MISSING_UUID}/subtasks`).set('Authorization', `Bearer ${ownerToken}`).send({ title: 'x' }),
        request(app).get(`/api/v1/tasks/${MISSING_UUID}/attachments`).set('Authorization', `Bearer ${ownerToken}`),
        request(app).post(`/api/v1/tasks/${MISSING_UUID}/attachments`).set('Authorization', `Bearer ${ownerToken}`).send({ r2Key: 'k', name: 'n' }),
      ]);
      for (const r of responses) expect(r.status).toBe(404);
    });
  });
});
