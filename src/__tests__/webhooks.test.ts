import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';
import { webhookDeliveries, webhookEndpoints } from '../db/schema/webhooks.js';
import { webhookQueue } from '../jobs/queue.js';
import {
  BASE_RETRY_DELAY_MS, DISABLE_AFTER_FAILED_DELIVERIES, MAX_ATTEMPTS, deliverOnce, dispatchEvent, retryDelayMs,
} from '../services/webhook.service.js';
import { verifyStatoSignature } from '../services/webhook-signature.js';

// Plan phase 4 (docs/creative-library-and-api-plan.md): outbound webhooks —
// Owner-managed endpoints, signed deliveries, retries, auto-disable.

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const tag = `wh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface Received { headers: http.IncomingHttpHeaders; body: string }
let received: Received[] = [];
let replyStatus = 200;
let receiver: http.Server;
let hookUrl: string;

let ownerToken: string;
let opsToken: string;
let otherBusinessId: string;
const createdEndpointIds: string[] = [];
const createdClientIds: string[] = [];

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.tokens.accessToken;
}

async function createEndpoint(events: string[], url = hookUrl) {
  const res = await request(app).post('/api/v1/webhook-endpoints')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ url, events, description: `test ${tag}` });
  expect(res.status).toBe(201);
  createdEndpointIds.push(res.body.data.endpoint.id);
  return res.body.data as { endpoint: { id: string }; secret: string };
}

/**
 * A delivery row for `endpointId` that is NOT queued. src/index.ts starts the
 * BullMQ workers on import, so a queued delivery is picked up by the real
 * webhook worker in this process — tests that drive deliverOnce() by hand use
 * this so the worker can't race them.
 */
async function unqueuedDelivery(endpointId: string, event: string, data: Record<string, unknown>) {
  const [row] = await db.insert(webhookDeliveries).values({ endpointId, event, payload: {} }).returning();
  const payload = { id: row.id, event, createdAt: new Date().toISOString(), data };
  await db.update(webhookDeliveries).set({ payload }).where(eq(webhookDeliveries.id, row.id));
  return row.id;
}

/** Dispatches and returns the delivery created for `endpointId` (other active endpoints may also get one). */
async function dispatchFor(endpointId: string, event: 'creative.added' | 'creative.changed' | 'client.added', data: Record<string, unknown>) {
  const ids = await dispatchEvent(event, { businessId: LEADGEN_BUSINESS_ID, data });
  const rows = await db.select().from(webhookDeliveries).where(inArray(webhookDeliveries.id, ids));
  const mine = rows.find((r) => r.endpointId === endpointId);
  expect(mine).toBeTruthy();
  return mine!.id;
}

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = replyStatus;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/stato-hook`;
  [ownerToken, opsToken] = await Promise.all([login('owner@stato.app', 'owner123'), login('ops@stato.app', 'ops123')]);
  const [b] = await db.insert(businesses).values({ name: `Other business ${tag}`, slug: `other-${tag}` }).returning();
  otherBusinessId = b.id;
});

afterAll(async () => {
  if (createdEndpointIds.length) await db.delete(webhookEndpoints).where(inArray(webhookEndpoints.id, createdEndpointIds));
  if (otherBusinessId) await db.delete(webhookEndpoints).where(eq(webhookEndpoints.businessId, otherBusinessId));
  if (createdClientIds.length) await db.delete(clients).where(inArray(clients.id, createdClientIds));
  if (otherBusinessId) await db.delete(businesses).where(eq(businesses.id, otherBusinessId));
  await new Promise((r) => receiver.close(r));
});

beforeEach(() => {
  received = [];
  replyStatus = 200;
});

describe('webhook endpoint management', () => {
  it('is Owner-only', async () => {
    const res = await request(app).get('/api/v1/webhook-endpoints').set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(403);
  });

  it('returns the signing secret once and never lists it', async () => {
    const { endpoint, secret } = await createEndpoint(['creative.added']);
    expect(secret).toMatch(/^whsec_/);
    const list = await request(app).get('/api/v1/webhook-endpoints').set('Authorization', `Bearer ${ownerToken}`);
    const row = list.body.data.endpoints.find((e: { id: string }) => e.id === endpoint.id);
    expect(row).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(row.secretSealed).toBeUndefined();
    expect(row.secretHint).toBe(secret.slice(0, 12));
    const [stored] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(stored.secretSealed).not.toContain(secret);
  });

  it('refuses unknown events and internal addresses with plain messages', async () => {
    const bad = await request(app).post('/api/v1/webhook-endpoints').set('Authorization', `Bearer ${ownerToken}`)
      .send({ url: hookUrl, events: ['invoice.paid'] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Unknown event invoice\.paid/);
    const meta = await request(app).post('/api/v1/webhook-endpoints').set('Authorization', `Bearer ${ownerToken}`)
      .send({ url: 'http://169.254.169.254/latest/meta-data', events: ['client.added'] });
    expect(meta.status).toBe(400);
    expect(meta.body.message).toMatch(/private or internal network/);
  });

  it('"Send test" delivers a signed webhook.test the receiver can verify', async () => {
    const { endpoint, secret } = await createEndpoint(['client.added']);
    const res = await request(app).post(`/api/v1/webhook-endpoints/${endpoint.id}/test`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    const got = received.find((x) => x.headers['x-stato-delivery'] === res.body.data.delivery.id)!;
    expect(got.headers['x-stato-event']).toBe('webhook.test');
    expect(verifyStatoSignature(got.headers['x-stato-signature'] as string, got.body, secret)).toEqual({ ok: true });
  });

  it('rotating the secret returns a new one and old signatures stop verifying', async () => {
    const { endpoint, secret } = await createEndpoint(['client.added']);
    const rot = await request(app).patch(`/api/v1/webhook-endpoints/${endpoint.id}`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ rotateSecret: true });
    expect(rot.status).toBe(200);
    const fresh: string = rot.body.data.secret;
    expect(fresh).toMatch(/^whsec_/);
    expect(fresh).not.toBe(secret);
    const t = await request(app).post(`/api/v1/webhook-endpoints/${endpoint.id}/test`).set('Authorization', `Bearer ${ownerToken}`);
    const got = received.find((x) => x.headers['x-stato-delivery'] === t.body.data.delivery.id)!;
    const sig = got.headers['x-stato-signature'] as string;
    expect(verifyStatoSignature(sig, got.body, fresh).ok).toBe(true);
    expect(verifyStatoSignature(sig, got.body, secret).ok).toBe(false);
  });
});

describe('fan-out and delivery', () => {
  it('only subscribed, active endpoints of the same business get a delivery', async () => {
    const creativeHook = await createEndpoint(['creative.added']);
    const clientHook = await createEndpoint(['client.added']);
    const off = await createEndpoint(['creative.added']);
    await request(app).patch(`/api/v1/webhook-endpoints/${off.endpoint.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ active: false });
    // Same event, other business — must not leak across.
    const [foreign] = await db.insert(webhookEndpoints).values({
      businessId: otherBusinessId, url: hookUrl, secretSealed: 'v1:x:y:z', secretHint: 'whsec_x', events: ['creative.added'],
    }).returning();

    const ids = await dispatchEvent('creative.added', { businessId: LEADGEN_BUSINESS_ID, data: { creative: { id: tag } } });
    const rows = await db.select().from(webhookDeliveries).where(inArray(webhookDeliveries.id, ids));
    const endpointsHit = rows.map((r) => r.endpointId);
    expect(endpointsHit).toContain(creativeHook.endpoint.id);
    expect(endpointsHit).not.toContain(clientHook.endpoint.id);
    expect(endpointsHit).not.toContain(off.endpoint.id);
    expect(endpointsHit).not.toContain(foreign.id);
    const mine = rows.find((r) => r.endpointId === creativeHook.endpoint.id)!;
    expect(mine.payload).toMatchObject({ id: mine.id, event: 'creative.added', data: { creative: { id: tag } } });
  });

  it('queues each delivery with 8 attempts and exponential backoff from 1 minute', async () => {
    expect(webhookQueue).toBeTruthy();
    const { endpoint } = await createEndpoint(['client.added']);
    const add = vi.spyOn(webhookQueue!, 'add');
    try {
      const id = await dispatchFor(endpoint.id, 'client.added', { client: { id: tag } });
      expect(add).toHaveBeenCalledWith('deliver', { deliveryId: id }, expect.objectContaining({
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: BASE_RETRY_DELAY_MS },
      }));
    } finally {
      add.mockRestore();
    }
  });

  it('end to end: event → BullMQ worker → signed POST → delivery marked succeeded', async () => {
    const { endpoint, secret } = await createEndpoint(['creative.added']);
    const id = await dispatchFor(endpoint.id, 'creative.added', { creative: { id: `${tag}-e2e` } });
    let status = '';
    for (let i = 0; i < 50 && status !== 'succeeded'; i++) {
      const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
      status = d.status;
      if (status !== 'succeeded') await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe('succeeded');
    const got = received.find((x) => x.headers['x-stato-delivery'] === id)!;
    expect(got.headers['x-stato-event']).toBe('creative.added');
    expect(verifyStatoSignature(got.headers['x-stato-signature'] as string, got.body, secret).ok).toBe(true);
  });

  it('a successful delivery is signed, carries a stable delivery id and resets failures', async () => {
    const { endpoint, secret } = await createEndpoint(['creative.changed']);
    await db.update(webhookEndpoints).set({ consecutiveFailures: 3 }).where(eq(webhookEndpoints.id, endpoint.id));
    const id = await unqueuedDelivery(endpoint.id, 'creative.changed', { creative: { id: tag } });
    const r = await deliverOnce(id, { attemptNumber: 1, finalAttempt: false });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const got = received.find((x) => x.headers['x-stato-delivery'] === id)!;
    expect(got.headers['content-type']).toBe('application/json');
    expect(verifyStatoSignature(got.headers['x-stato-signature'] as string, got.body, secret).ok).toBe(true);
    expect(JSON.parse(got.body)).toMatchObject({ id, event: 'creative.changed', data: { creative: { id: tag } } });
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(d).toMatchObject({ status: 'succeeded', attempts: 1, responseCode: 200 });
    const [ep] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep.consecutiveFailures).toBe(0);
  });

  it('a failing endpoint is retried on the 1, 2, 4 … minute schedule, then marked failed', async () => {
    replyStatus = 500;
    const { endpoint } = await createEndpoint(['creative.added']);
    const id = await unqueuedDelivery(endpoint.id, 'creative.added', {});
    const now = new Date('2026-09-29T10:00:00Z');
    for (const attempt of [1, 3]) {
      const r = await deliverOnce(id, { attemptNumber: attempt, finalAttempt: false, now: () => now });
      expect(r).toMatchObject({ ok: false, final: false, status: 500 });
      const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
      expect(d.status).toBe('retrying');
      expect(d.lastError).toBe('Endpoint answered HTTP 500');
      expect(d.nextAttemptAt!.getTime() - now.getTime()).toBe(retryDelayMs(attempt));
    }
    expect([1, 2, 3, 7].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 3_840_000]);
    await deliverOnce(id, { attemptNumber: MAX_ATTEMPTS, finalAttempt: true });
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(d).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    const [ep] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep.consecutiveFailures).toBe(1);
    expect(ep.active).toBe(true);
  });

  it(`turns an endpoint off after ${DISABLE_AFTER_FAILED_DELIVERIES} deliveries in a row fail, and later ones are cancelled`, async () => {
    replyStatus = 503;
    const { endpoint } = await createEndpoint(['client.added']);
    for (let i = 0; i < DISABLE_AFTER_FAILED_DELIVERIES; i++) {
      const id = await unqueuedDelivery(endpoint.id, 'client.added', { n: i });
      await deliverOnce(id, { attemptNumber: MAX_ATTEMPTS, finalAttempt: true });
    }
    const [ep] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep.active).toBe(false);
    expect(ep.disabledReason).toMatch(new RegExp(`Turned off after ${DISABLE_AFTER_FAILED_DELIVERIES} deliveries in a row failed`));
    // A delivery already queued for it is cancelled, not sent.
    const pendingId = await unqueuedDelivery(endpoint.id, 'client.added', {});
    const r = await deliverOnce(pendingId, { attemptNumber: 1, finalAttempt: false });
    expect(r.ok).toBe(false);
    expect(received.filter((x) => x.headers['x-stato-delivery'] === pendingId)).toHaveLength(0);
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pendingId));
    expect(d.status).toBe('cancelled');
    // Turning it back on clears the failure count.
    const on = await request(app).patch(`/api/v1/webhook-endpoints/${endpoint.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ active: true });
    expect(on.body.data.endpoint).toMatchObject({ active: true, consecutiveFailures: 0, disabledReason: null });
  });

  it('creating a client emits client.added to subscribed endpoints', async () => {
    const { endpoint } = await createEndpoint(['client.added']);
    const res = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${ownerToken}`)
      .send({ companyName: `Yash Test Webhook Client ${tag}` });
    expect(res.status).toBe(201);
    createdClientIds.push(res.body.data.client.id);
    let rows: typeof webhookDeliveries.$inferSelect[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id));
      if (!rows.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('client.added');
    expect(rows[0].payload).toMatchObject({ data: { client: { id: res.body.data.client.id, companyName: `Yash Test Webhook Client ${tag}` } } });
  });
});
