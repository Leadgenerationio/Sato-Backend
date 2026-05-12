import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../config/database.js';
import { sosHelpRequests } from '../db/schema/sos-help.js';
import { eq } from 'drizzle-orm';

// Slice 5 Day 6 (Sam Loom #100). The SOS button hits /api/v1/sos.
// We exercise: auth required, owner/ops/finance can post, clients can post
// too (button is a support escape hatch), wa.me link is correctly shaped,
// missing config returns recorded request but no link, internal-only
// resolve flow.

let ownerToken: string;
let clientToken: string;
let originalEnv: string | undefined;
const createdIds: string[] = [];

describe('SOS help button', () => {
  beforeAll(async () => {
    originalEnv = process.env.SOS_WHATSAPP_NUMBER;
    process.env.SOS_WHATSAPP_NUMBER = '+44 7700 900123';

    const ownerRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@stato.app', password: 'owner123' });
    ownerToken = ownerRes.body.data.tokens.accessToken;

    const clientRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'client@stato.app', password: 'client123' });
    clientToken = clientRes.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    // Clean up rows we created so successive runs aren't noisy.
    for (const id of createdIds) {
      try { await db.delete(sosHelpRequests).where(eq(sosHelpRequests.id, id)); } catch { /* ignore */ }
    }
    if (originalEnv === undefined) delete process.env.SOS_WHATSAPP_NUMBER;
    else process.env.SOS_WHATSAPP_NUMBER = originalEnv;
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/sos')
      .send({ message: 'help' });
    expect(res.status).toBe(401);
  });

  it('owner: records request + returns wa.me link', async () => {
    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pagePath: '/dashboard', message: 'Stuck on bank widget' });
    expect(res.status).toBe(201);

    const { request: req, whatsappLink, recipientNumber } = res.body.data;
    expect(req.id).toBeTruthy();
    expect(req.pagePath).toBe('/dashboard');
    expect(req.message).toBe('Stuck on bank widget');
    // Number normalisation: + and spaces stripped.
    expect(recipientNumber).toBe('447700900123');
    // Link shape: wa.me/<digits>?text=<encoded>
    expect(whatsappLink.startsWith('https://wa.me/447700900123?text=')).toBe(true);
    // The prefilled text should mention the page + user-supplied message.
    expect(decodeURIComponent(whatsappLink.split('text=')[1])).toContain('/dashboard');
    expect(decodeURIComponent(whatsappLink.split('text=')[1])).toContain('Stuck on bank widget');

    createdIds.push(req.id);
  });

  it('client: can also post (button is a support escape hatch)', async () => {
    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ pagePath: '/portal', message: "I can't see my invoices" });
    expect(res.status).toBe(201);
    expect(res.body.data.request.message).toBe("I can't see my invoices");
    createdIds.push(res.body.data.request.id);
  });

  it('accepts an empty message and uses a friendly default in the WA text', async () => {
    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(201);
    const decoded = decodeURIComponent(res.body.data.whatsappLink.split('text=')[1]);
    // Falls back to the "I'm stuck and need a hand." line.
    expect(decoded).toContain('stuck');
    createdIds.push(res.body.data.request.id);
  });

  it('returns no link when SOS_WHATSAPP_NUMBER is unset', async () => {
    const prev = process.env.SOS_WHATSAPP_NUMBER;
    delete process.env.SOS_WHATSAPP_NUMBER;

    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'no link please' });
    expect(res.status).toBe(201);
    expect(res.body.data.whatsappLink).toBe('');
    expect(res.body.data.recipientNumber).toBeNull();
    // Request still recorded.
    expect(res.body.data.request.id).toBeTruthy();
    createdIds.push(res.body.data.request.id);

    process.env.SOS_WHATSAPP_NUMBER = prev;
  });

  it('treats a too-short number as unconfigured', async () => {
    const prev = process.env.SOS_WHATSAPP_NUMBER;
    process.env.SOS_WHATSAPP_NUMBER = '12';  // too few digits

    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'bogus number' });
    expect(res.status).toBe(201);
    expect(res.body.data.whatsappLink).toBe('');
    expect(res.body.data.recipientNumber).toBeNull();
    createdIds.push(res.body.data.request.id);

    process.env.SOS_WHATSAPP_NUMBER = prev;
  });

  it('rejects message longer than 2000 chars via zod', async () => {
    const res = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'a'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('owner: can list SOS queue', async () => {
    const res = await request(app)
      .get('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.requests)).toBe(true);
    // We created several rows above — at least one of them shows up.
    expect(res.body.data.requests.length).toBeGreaterThan(0);
  });

  it('client: blocked from listing the queue', async () => {
    const res = await request(app)
      .get('/api/v1/sos')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(403);
  });

  it('owner: can resolve a request', async () => {
    // Create one to resolve.
    const createRes = await request(app)
      .post('/api/v1/sos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'will resolve' });
    const sosId = createRes.body.data.request.id;
    createdIds.push(sosId);

    const res = await request(app)
      .post(`/api/v1/sos/${sosId}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.request.resolvedAt).toBeTruthy();
  });

  it('owner: resolve 404 for unknown id', async () => {
    const res = await request(app)
      .post('/api/v1/sos/00000000-0000-0000-0000-000000000000/resolve')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });
});
