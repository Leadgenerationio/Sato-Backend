import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';

// #91 AI new-task button. We mock global.fetch so the Anthropic call
// never hits the network. The endpoint contract we're locking in:
//   - 401 without auth
//   - 403 for clients (internal-only)
//   - 503 when ANTHROPIC_API_KEY is unset
//   - 200 with a parsed suggestion on happy path
//   - 502 when the model returns unparseable JSON
//   - 400 when prompt is missing/empty

let ownerToken: string;
let clientToken: string;
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

function mockAnthropicResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      content: [{ type: 'text', text }],
    }),
    text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
  } as unknown as Response;
}

const VALID_SUGGESTION = JSON.stringify({
  title: 'Process weekly Xero export',
  description: 'Download the weekly transaction export from Xero, reconcile against bank feed, and file in shared drive.',
  category: 'Finance',
  priority: 'high',
  timeBlockMinutes: 60,
  linkedSopId: null,
  subtasks: [
    'Download CSV from Xero',
    'Reconcile against bank feed',
    'Upload to shared drive',
  ],
});

describe('POST /api/v1/tasks/ai-generate', () => {
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;
    const clientRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  afterAll(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .send({ prompt: 'do thing' });
    expect(res.status).toBe(401);
  });

  it('blocks clients (internal-only)', async () => {
    global.fetch = vi.fn(async () => mockAnthropicResponse(VALID_SUGGESTION)) as unknown as typeof fetch;
    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ prompt: 'do thing' });
    expect(res.status).toBe(403);
  });

  it('rejects missing prompt (400)', async () => {
    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects empty prompt (400)', async () => {
    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects oversized prompt via zod', async () => {
    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'a'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('returns 503 when ANTHROPIC_API_KEY is unset', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'monthly Xero export' });
    expect(res.status).toBe(503);

    process.env.ANTHROPIC_API_KEY = prev;
  });

  it('returns parsed suggestion on happy path', async () => {
    global.fetch = vi.fn(async () => mockAnthropicResponse(VALID_SUGGESTION)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'monthly Xero VAT export and submission' });
    expect(res.status).toBe(200);

    const s = res.body.data.suggestion;
    expect(s.title).toBe('Process weekly Xero export');
    expect(s.priority).toBe('high');
    expect(s.timeBlockMinutes).toBe(60);
    expect(s.category).toBe('Finance');
    expect(Array.isArray(s.subtasks)).toBe(true);
    expect(s.subtasks.length).toBe(3);
    // linkedSopId comes back as null because we passed null in the mock —
    // and the service refuses to trust IDs it didn't offer.
    expect(s.linkedSopId).toBeNull();
  });

  it('strips markdown code fences from model output', async () => {
    const fenced = '```json\n' + VALID_SUGGESTION + '\n```';
    global.fetch = vi.fn(async () => mockAnthropicResponse(fenced)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'test fence handling' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.title).toBe('Process weekly Xero export');
  });

  it('coerces invalid priority to medium', async () => {
    const bogus = JSON.stringify({
      title: 'Test task',
      description: 'x',
      category: 'Other',
      priority: 'BANANA',
      timeBlockMinutes: 30,
      linkedSopId: null,
      subtasks: ['a', 'b', 'c'],
    });
    global.fetch = vi.fn(async () => mockAnthropicResponse(bogus)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'test priority coercion' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.priority).toBe('medium');
  });

  it('coerces unknown time-block to null', async () => {
    const bogus = JSON.stringify({
      title: 'Test task',
      description: 'x',
      category: 'Other',
      priority: 'medium',
      timeBlockMinutes: 99,           // not in the allowed set
      linkedSopId: null,
      subtasks: ['a'],
    });
    global.fetch = vi.fn(async () => mockAnthropicResponse(bogus)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'test time-block coercion' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.timeBlockMinutes).toBeNull();
  });

  it('refuses linkedSopId the model invented (never offered)', async () => {
    const invented = JSON.stringify({
      title: 'Test task',
      description: 'x',
      category: 'Other',
      priority: 'medium',
      timeBlockMinutes: 30,
      linkedSopId: '00000000-0000-0000-0000-000000000099',  // not in the SOP hint list
      subtasks: ['a'],
    });
    global.fetch = vi.fn(async () => mockAnthropicResponse(invented)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'test linked-sop guard' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.linkedSopId).toBeNull();
    expect(res.body.data.suggestion.linkedSopTitle).toBeNull();
  });

  it('returns 502 on unparseable model output', async () => {
    global.fetch = vi.fn(async () => mockAnthropicResponse('not json at all just prose')) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'trigger bad output' });
    expect(res.status).toBe(502);
  });

  it('returns 500 on upstream HTTP error', async () => {
    global.fetch = vi.fn(async () => mockAnthropicResponse('{"error":{"message":"rate limited"}}', 429)) as unknown as typeof fetch;

    const res = await request(app)
      .post('/api/v1/tasks/ai-generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ prompt: 'trigger upstream error' });
    expect(res.status).toBe(500);
  });
});
