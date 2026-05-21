import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { workflows } from '../db/schema/workflows.js';
import { isAutomationPaused } from '../services/workflow.service.js';

// T4 (Sam, 2026-05-20) — explicit pause / resume endpoints + worker
// guard. Locks in the rules:
//   - POST /workflows/:id/pause is idempotent (200 every time)
//   - POST /workflows/:id/resume is idempotent (200 every time)
//   - client role gets 403
//   - isAutomationPaused() returns true only when status='paused'
//   - paused state on a workflow whose handler_key matches a cron job
//     short-circuits the corresponding cron handler (verified by the
//     helper directly — exercising the BullMQ Worker callback requires
//     redis + a job, which the broader test suite already covers)

const tag = `t4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let ownerToken: string;
let clientToken: string;
const createdWorkflowIds: string[] = [];

async function makeWorkflow(opts: { handlerKey?: string; status?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(workflows)
    .values({
      name: `T4 wf ${tag}-${createdWorkflowIds.length}`,
      businessId: LEADGEN_BUSINESS_ID,
      type: 'scheduled',
      handlerKey: opts.handlerKey ?? null,
      status: opts.status ?? 'active',
      steps: [],
    })
    .returning();
  createdWorkflowIds.push(row.id);
  return row.id;
}

describe('Workflow pause/resume (T4)', () => {
  beforeAll(async () => {
    const ownerRes = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app).post('/api/v1/auth/login').send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (createdWorkflowIds.length > 0) {
      await db.delete(workflows).where(inArray(workflows.id, createdWorkflowIds));
    }
  });

  it('POST /workflows/:id/pause flips active → paused', async () => {
    const id = await makeWorkflow({ status: 'active' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/pause`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.status).toBe('paused');

    const [row] = await db.select().from(workflows).where(eq(workflows.id, id));
    expect(row.status).toBe('paused');
  });

  it('POST /workflows/:id/pause is idempotent (already-paused returns 200 with current state)', async () => {
    const id = await makeWorkflow({ status: 'paused' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/pause`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.status).toBe('paused');
  });

  it('POST /workflows/:id/resume flips paused → active', async () => {
    const id = await makeWorkflow({ status: 'paused' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/resume`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.status).toBe('active');

    const [row] = await db.select().from(workflows).where(eq(workflows.id, id));
    expect(row.status).toBe('active');
  });

  it('POST /workflows/:id/resume is idempotent (already-active returns 200 with current state)', async () => {
    const id = await makeWorkflow({ status: 'active' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/resume`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.status).toBe('active');
  });

  it('client role cannot pause workflows', async () => {
    const id = await makeWorkflow({ status: 'active' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/pause`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  it('client role cannot resume workflows', async () => {
    const id = await makeWorkflow({ status: 'paused' });
    const res = await request(app)
      .post(`/api/v1/workflows/${id}/resume`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  it('pause on non-existent workflow returns 404', async () => {
    const res = await request(app)
      .post('/api/v1/workflows/00000000-0000-0000-0000-000000000000/pause')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('isAutomationPaused returns true when the handler_key workflow is paused', async () => {
    const handlerKey = `${tag}-handler`;
    await makeWorkflow({ handlerKey, status: 'paused' });
    expect(await isAutomationPaused(handlerKey)).toBe(true);
  });

  it('isAutomationPaused returns false when active', async () => {
    const handlerKey = `${tag}-handler-active`;
    await makeWorkflow({ handlerKey, status: 'active' });
    expect(await isAutomationPaused(handlerKey)).toBe(false);
  });

  it('isAutomationPaused returns false when no workflow uses the key', async () => {
    expect(await isAutomationPaused(`${tag}-none`)).toBe(false);
  });

  // PR #7's seed migration creates one workflow row per business with the
  // same handler_key. The earlier LIMIT-1-no-ORDER-BY implementation was
  // nondeterministic — Postgres could return any row, so the cron-skip
  // depended on which tenant Postgres happened to surface. The any-paused
  // semantics below guarantees: if ANY admin has flagged the automation
  // paused, the cron short-circuits.
  it('isAutomationPaused returns true if any matching row is paused (multi-tenant)', async () => {
    const handlerKey = `${tag}-handler-mt`;
    await makeWorkflow({ handlerKey, status: 'active' });
    await makeWorkflow({ handlerKey, status: 'paused' });
    await makeWorkflow({ handlerKey, status: 'active' });
    expect(await isAutomationPaused(handlerKey)).toBe(true);
  });

  it('isAutomationPaused returns false when all matching rows are active (multi-tenant)', async () => {
    const handlerKey = `${tag}-handler-all-active`;
    await makeWorkflow({ handlerKey, status: 'active' });
    await makeWorkflow({ handlerKey, status: 'active' });
    expect(await isAutomationPaused(handlerKey)).toBe(false);
  });
});
