import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { and, arrayContains, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { webhookDeliveries, webhookEndpoints, type WebhookEndpointRow, type WebhookDeliveryRow } from '../db/schema/webhooks.js';
import { webhookQueue } from '../jobs/queue.js';
import { domainEvents, type DomainEventName, type DomainEventPayload } from './events.js';
import { assertWebhookUrl, defaultPolicy, guardedLookup, isBlockedAddress, type UrlPolicy } from './webhook-url-guard.js';
import { buildSignatureHeader, generateWebhookSecret, SIGNATURE_HEADER } from './webhook-signature.js';
import { openSecret, sealSecret } from '../utils/secret-box.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// Plan phase 4: outbound webhooks. Flow:
//   domainEvents.emit('creative.added', {businessId, data})
//     → dispatchEvent(): one webhook_deliveries row per subscribed endpoint
//     → BullMQ 'webhook' job per delivery (retries with exponential backoff)
//     → deliverOnce(): signed POST, result recorded on the delivery row.
// The delivery id is sent as X-Stato-Delivery and stays the same across
// retries, so a receiver can ignore a delivery it has already processed.

export const WEBHOOK_EVENTS = ['creative.added', 'creative.changed', 'client.added'] as const satisfies readonly DomainEventName[];
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const TEST_EVENT = 'webhook.test';

export const MAX_ATTEMPTS = 8;
export const BASE_RETRY_DELAY_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
/** An endpoint is switched off after this many deliveries in a row fail all their attempts. */
export const DISABLE_AFTER_FAILED_DELIVERIES = 5;

/** Wait before attempt `attemptNumber + 1`: 1, 2, 4 … 64 minutes (≈2 h over 8 attempts). Mirrors BullMQ's exponential backoff. */
export function retryDelayMs(attemptNumber: number): number {
  return BASE_RETRY_DELAY_MS * 2 ** (attemptNumber - 1);
}

export type PublicEndpoint = Omit<WebhookEndpointRow, 'secretSealed'>;

function toPublic(row: WebhookEndpointRow): PublicEndpoint {
  const { secretSealed: _omit, ...rest } = row;
  return rest;
}

function businessOf(requester: AuthPayload): string {
  if (!requester.businessId) throw new ForbiddenError('No business on this account');
  return requester.businessId;
}

function assertEvents(events: string[]): WebhookEvent[] {
  const unique = [...new Set(events)];
  const bad = unique.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (bad.length) throw new ValidationError(`Unknown event ${bad.join(', ')}. Choose from ${WEBHOOK_EVENTS.join(', ')}.`);
  if (unique.length === 0) throw new ValidationError('Choose at least one event to send');
  return unique as WebhookEvent[];
}

async function loadOwned(requester: AuthPayload, id: string): Promise<WebhookEndpointRow> {
  const [row] = await db.select().from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.businessId, businessOf(requester))));
  if (!row) throw new NotFoundError('Webhook');
  return row;
}

// ─── Endpoint management (Owner) ────────────────────────────────────────────

export async function listEndpoints(requester: AuthPayload): Promise<PublicEndpoint[]> {
  const rows = await db.select().from(webhookEndpoints)
    .where(eq(webhookEndpoints.businessId, businessOf(requester)))
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(toPublic);
}

export async function createEndpoint(
  requester: AuthPayload,
  input: { url: string; events: string[]; description?: string | null },
  policy: UrlPolicy = defaultPolicy(),
): Promise<{ endpoint: PublicEndpoint; secret: string }> {
  const url = await assertWebhookUrl(input.url, policy);
  const events = assertEvents(input.events);
  const secret = generateWebhookSecret();
  const [row] = await db.insert(webhookEndpoints).values({
    businessId: businessOf(requester),
    url: url.toString(),
    description: input.description?.trim() || null,
    secretSealed: sealSecret(secret),
    secretHint: secret.slice(0, 12),
    events,
    createdBy: requester.userId === 'system' ? null : requester.userId,
  }).returning();
  return { endpoint: toPublic(row), secret };
}

export async function updateEndpoint(
  requester: AuthPayload,
  id: string,
  patch: { url?: string; events?: string[]; description?: string | null; active?: boolean; rotateSecret?: boolean },
  policy: UrlPolicy = defaultPolicy(),
): Promise<{ endpoint: PublicEndpoint; secret?: string }> {
  const current = await loadOwned(requester, id);
  const set: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
  if (patch.url !== undefined) set.url = (await assertWebhookUrl(patch.url, policy)).toString();
  if (patch.events !== undefined) set.events = assertEvents(patch.events);
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.active !== undefined) {
    set.active = patch.active;
    // Turning an endpoint back on gives it a clean slate.
    if (patch.active && !current.active) Object.assign(set, { consecutiveFailures: 0, disabledAt: null, disabledReason: null });
  }
  let secret: string | undefined;
  if (patch.rotateSecret) {
    secret = generateWebhookSecret();
    Object.assign(set, { secretSealed: sealSecret(secret), secretHint: secret.slice(0, 12) });
  }
  const [row] = await db.update(webhookEndpoints).set(set).where(eq(webhookEndpoints.id, id)).returning();
  return { endpoint: toPublic(row), ...(secret ? { secret } : {}) };
}

export async function deleteEndpoint(requester: AuthPayload, id: string): Promise<void> {
  await loadOwned(requester, id);
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
}

export async function listDeliveries(requester: AuthPayload, id: string, limit = 50): Promise<WebhookDeliveryRow[]> {
  await loadOwned(requester, id);
  return db.select().from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Sends one signed `webhook.test` delivery right now (no retries) and returns the outcome. */
export async function sendTest(requester: AuthPayload, id: string): Promise<DeliveryResult & { delivery: WebhookDeliveryRow | undefined }> {
  const endpoint = await loadOwned(requester, id);
  const deliveryId = await insertDelivery(endpoint, TEST_EVENT, {
    message: 'Test delivery from Stato. If you can read this, your endpoint and signature check work.',
  });
  const result = await deliverOnce(deliveryId, { attemptNumber: 1, finalAttempt: true, countTowardsDisable: false });
  const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  return { ...result, delivery };
}

export async function redeliver(requester: AuthPayload, endpointId: string, deliveryId: string): Promise<void> {
  await loadOwned(requester, endpointId);
  const [d] = await db.update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.endpointId, endpointId)))
    .returning();
  if (!d) throw new NotFoundError('Delivery');
  await enqueueDelivery(d.id);
}

// ─── Fan-out ────────────────────────────────────────────────────────────────

async function insertDelivery(endpoint: WebhookEndpointRow, event: string, data: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.insert(webhookDeliveries).values({
    id,
    endpointId: endpoint.id,
    event,
    payload: { id, event, createdAt: new Date().toISOString(), data },
  });
  return id;
}

/** Creates a delivery for every active endpoint of the business subscribed to `event`. Returns the delivery ids. */
export async function dispatchEvent(event: WebhookEvent, payload: DomainEventPayload): Promise<string[]> {
  if (!payload?.businessId) return [];
  const endpoints = await db.select().from(webhookEndpoints).where(and(
    eq(webhookEndpoints.businessId, payload.businessId),
    eq(webhookEndpoints.active, true),
    arrayContains(webhookEndpoints.events, [event]),
  ));
  const ids: string[] = [];
  for (const ep of endpoints) {
    const id = await insertDelivery(ep, event, payload.data ?? {});
    ids.push(id);
    await enqueueDelivery(id);
  }
  return ids;
}

let enqueueSeq = 0;
async function enqueueDelivery(deliveryId: string): Promise<void> {
  if (webhookQueue) {
    await webhookQueue.add('deliver', { deliveryId }, {
      // Unique per enqueue so a manual redeliver isn't deduped away.
      jobId: `wh-${deliveryId}-${Date.now()}-${enqueueSeq++}`,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: BASE_RETRY_DELAY_MS },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    return;
  }
  // No Redis (local dev without it): one attempt, no retries.
  logger.warn({ deliveryId }, 'Redis not configured — webhook delivered once without retries');
  setImmediate(() => {
    deliverOnce(deliveryId, { attemptNumber: 1, finalAttempt: true }).catch((err) => logger.error({ err, deliveryId }, 'Webhook delivery crashed'));
  });
}

let subscribed = false;
/** Wires domainEvents → dispatchEvent. Call once at API start-up. */
export function registerWebhookSubscriber(): void {
  if (subscribed) return;
  subscribed = true;
  for (const event of WEBHOOK_EVENTS) {
    domainEvents.on(event, (payload: DomainEventPayload) => {
      dispatchEvent(event, payload).catch((err) => logger.error({ err, event }, 'Webhook dispatch failed'));
    });
  }
}

// ─── Delivery ───────────────────────────────────────────────────────────────

export interface PostResult { status?: number; error?: string }

/**
 * POST with a hard TOTAL deadline (lookup, connect, TLS, the request and the answer's status line), no redirects, and the
 * SSRF guard on the connection. `timeout` on the request is only an idle timer that every byte resets, so an endpoint
 * that drips bytes could hold a delivery for minutes; the deadline below cannot be reset. The answer is the status line:
 * as soon as it arrives the result is known and the rest of the body is dropped (it is never stored).
 */
export function postSigned(rawUrl: string, body: string, headers: Record<string, string>, policy: UrlPolicy = defaultPolicy(), timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<PostResult> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const settle = (r: PostResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(r);
    };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return settle({ error: 'Invalid URL' });
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.production)) {
      return settle({ error: 'Webhook addresses must use https' });
    }
    // Node skips `lookup` for IP-literal hosts, so check those here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlockedAddress(host, policy)) return settle({ error: `Blocked webhook destination ${host}` });
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      timeout: timeoutMs,
      lookup: guardedLookup(policy) as unknown as typeof import('node:dns').lookup,
    }, (res) => {
      res.on('error', () => undefined); // an IncomingMessage 'error' with no listener would crash the process
      settle({ status: res.statusCode });
      res.destroy(); // the body is not stored; do not wait for a slow one
    });
    deadline = setTimeout(() => {
      settle({ error: `No response within ${timeoutMs / 1000}s` });
      req.destroy();
    }, timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`No response within ${timeoutMs / 1000}s`)));
    req.on('error', (err) => settle({ error: err.message }));
    req.end(body);
  });
}

export interface DeliveryResult { ok: boolean; final: boolean; status?: number; error?: string }

export async function deliverOnce(
  deliveryId: string,
  opts: { attemptNumber: number; finalAttempt: boolean; countTowardsDisable?: boolean; policy?: UrlPolicy; now?: () => Date },
): Promise<DeliveryResult> {
  const now = opts.now ?? (() => new Date());
  const [row] = await db.select({ d: webhookDeliveries, e: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) return { ok: false, final: true, error: 'Delivery not found' };
  const { d, e } = row;
  if (!e.active) {
    await db.update(webhookDeliveries).set({ status: 'cancelled', nextAttemptAt: null, lastError: 'Webhook is turned off' })
      .where(eq(webhookDeliveries.id, d.id));
    return { ok: false, final: true, error: 'Webhook is turned off' };
  }

  const body = JSON.stringify(d.payload);
  let result: PostResult;
  try {
    result = await postSigned(e.url, body, {
      'Content-Type': 'application/json',
      'User-Agent': 'Stato-Webhooks/1.0',
      'X-Stato-Event': d.event,
      'X-Stato-Delivery': d.id,
      [SIGNATURE_HEADER]: buildSignatureHeader(openSecret(e.secretSealed), body, now()),
    }, opts.policy);
  } catch (err) {
    if (err instanceof AppError) throw err;
    result = { error: (err as Error).message };
  }

  const ok = !result.error && result.status !== undefined && result.status >= 200 && result.status < 300;
  const error = ok ? undefined : result.error ?? `Endpoint answered HTTP ${result.status}`;
  const at = now();

  if (ok) {
    await db.update(webhookDeliveries).set({
      status: 'succeeded', attempts: opts.attemptNumber, responseCode: result.status ?? null,
      deliveredAt: at, nextAttemptAt: null, lastError: null,
    }).where(eq(webhookDeliveries.id, d.id));
    await db.update(webhookEndpoints).set({ consecutiveFailures: 0, lastSuccessAt: at }).where(eq(webhookEndpoints.id, e.id));
    return { ok: true, final: true, status: result.status };
  }

  await db.update(webhookDeliveries).set({
    status: opts.finalAttempt ? 'failed' : 'retrying',
    attempts: opts.attemptNumber,
    responseCode: result.status ?? null,
    lastError: error!.slice(0, 500),
    nextAttemptAt: opts.finalAttempt ? null : new Date(at.getTime() + retryDelayMs(opts.attemptNumber)),
  }).where(eq(webhookDeliveries.id, d.id));

  if (opts.finalAttempt && opts.countTowardsDisable !== false) {
    const [ep] = await db.update(webhookEndpoints)
      .set({ consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`, lastFailureAt: at })
      .where(eq(webhookEndpoints.id, e.id))
      .returning({ failures: webhookEndpoints.consecutiveFailures });
    if (ep && ep.failures >= DISABLE_AFTER_FAILED_DELIVERIES) {
      await db.update(webhookEndpoints).set({
        active: false,
        disabledAt: at,
        disabledReason: `Turned off after ${ep.failures} deliveries in a row failed. Last error: ${error!.slice(0, 120)}`,
      }).where(eq(webhookEndpoints.id, e.id));
      logger.warn({ endpointId: e.id, failures: ep.failures }, 'Webhook endpoint turned off after repeated failures');
    }
  } else if (!opts.finalAttempt) {
    await db.update(webhookEndpoints).set({ lastFailureAt: at }).where(eq(webhookEndpoints.id, e.id));
  }
  return { ok: false, final: opts.finalAttempt, status: result.status, error };
}
