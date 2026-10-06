import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { and, eq, gt } from 'drizzle-orm';
import { authMiddleware } from './auth.middleware.js';
import { requireRole } from './rbac.middleware.js';
import { verifyApiKey, logApiKeyUse, type ApiScope } from '../services/api-key.service.js';
import { db } from '../config/database.js';
import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RedisRateLimitStore } from './redis-rate-limit-store.js';
import { idempotencyKeys } from '../db/schema/api-keys.js';
import { UnauthorizedError, AppError } from '../utils/errors.js';
import type { UserRole } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: { id: string; prefix: string; scopes: string[] };
    }
  }
}

/**
 * Accepts `X-API-Key: stk_…` (public API) or the usual `Authorization:
 * Bearer <jwt>`. A key acts inside its own business with the role of an
 * ops manager (never owner) and only within its scopes — see requireScope.
 */
/** `Authorization: Bearer stk_...` is a key too (the MCP spec and Cursor send it
 *  that way). A real login token never starts with stk_, so this is unambiguous. */
function bearerApiKey(req: Request): string | undefined {
  const h = req.get('authorization');
  return h && /^Bearer\s+stk_/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : undefined;
}

export async function apiKeyOrJwt(req: Request, res: Response, next: NextFunction) {
  const key = req.get('x-api-key') ?? bearerApiKey(req);
  if (!key) return authMiddleware(req, res, next);
  const row = await verifyApiKey(key.trim());
  if (!row) throw new UnauthorizedError('Invalid, expired or revoked API key');
  req.apiKey = { id: row.id, prefix: row.prefix, scopes: row.scopes };
  req.user = {
    userId: row.createdBy ?? '00000000-0000-0000-0000-000000000000',
    email: `api-key:${row.prefix}`,
    role: 'ops_manager',
    businessId: row.businessId,
  };
  res.on('finish', () => logApiKeyUse(row.id, req.method, req.originalUrl.split('?')[0]!, res.statusCode));
  next();
}

/** JWT callers are checked by role; API-key callers by scope. */
export function allow(roles: UserRole[], scope: ApiScope): RequestHandler {
  const byRole = requireRole(...roles);
  return (req, res, next) => {
    if (!req.apiKey) return byRole(req, res, next);
    if (!req.apiKey.scopes.includes(scope)) {
      res.status(403).json({ status: 'error', code: 'insufficient_scope', message: `This API key doesn't have the "${scope}" scope` });
      return;
    }
    next();
  };
}

export const requireScope = (scope: ApiScope): RequestHandler => allow([], scope);

// Dedicated connection for the limiter: no offline queue, so while Redis is
// down commands fail at once (and passOnStoreError lets the request through)
// instead of queueing and replaying inflated counts on reconnect.
const redis = env.REDIS_URL
  ? new IORedis.default(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: false })
  : null;
redis?.on('error', (err: Error) => logger.warn({ err: err.message }, 'Rate-limit Redis error'));

if (!redis && process.env.NODE_ENV === 'production') {
  logger.warn('REDIS_URL not set — API-key rate limit is counted per process, so the effective limit multiplies by the number of instances');
}

/** 120 requests / minute per API key. JWT traffic keeps the global limiter only. */
export const apiKeyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Shared across instances when Redis is configured; per-process otherwise.
  ...(redis ? { store: new RedisRateLimitStore(redis) } : {}),
  passOnStoreError: true,
  skip: (req) => !req.apiKey,
  keyGenerator: (req) => `api-key:${req.apiKey?.id ?? 'none'}`,
  message: { status: 'error', message: 'Rate limit for this API key reached (120 requests a minute). Try again shortly.' },
});

const inFlightIdempotency = new Set<string>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `Idempotency-Key` header: the first response for (caller, key) is stored
 * for 24 h and replayed for retries with the same body; a different body
 * with the same key is refused (422).
 */
export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.get('idempotency-key')?.trim();
  if (!key) return next();
  if (key.length > 100) throw new AppError(422, 'Idempotency-Key must be at most 100 characters');
  const owner = req.apiKey ? `key:${req.apiKey.id}` : `user:${req.user?.userId ?? 'anon'}`;
  const requestHash = createHash('sha256').update(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
  const since = new Date(Date.now() - IDEMPOTENCY_TTL_MS);
  const [hit] = await db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.owner, owner), eq(idempotencyKeys.key, key), gt(idempotencyKeys.createdAt, since)));
  if (hit) {
    if (hit.requestHash !== requestHash) {
      res.status(422).json({ status: 'error', code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request body' });
      return;
    }
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(hit.status).json(hit.response);
    return;
  }
  // A second request with the same key while the first is still running would
  // run the handler twice (two creatives). Tell the client to retry instead.
  const flightKey = `${owner}|${key}`;
  if (inFlightIdempotency.has(flightKey)) {
    res.status(409).json({ status: 'error', code: 'idempotency_key_in_progress', message: 'A request with this Idempotency-Key is still being processed. Retry shortly.' });
    return;
  }
  inFlightIdempotency.add(flightKey);
  const release = () => inFlightIdempotency.delete(flightKey);
  res.once('finish', release);
  res.once('close', release);
  const json = res.json.bind(res);
  // Store BEFORE sending, so a retry fired the moment the client sees the
  // response is already a replay. Only successes are stored: a validation
  // error must not be replayed once the caller fixes the body, and server
  // errors are retryable.
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) return json(body);
    db.insert(idempotencyKeys).values({ owner, key, requestHash, status: res.statusCode, response: body as object })
      .onConflictDoUpdate({ target: [idempotencyKeys.owner, idempotencyKeys.key], set: { requestHash, status: res.statusCode, response: body as object, createdAt: new Date() } })
      .catch(() => {})
      .finally(() => json(body));
    return res;
  }) as Response['json'];
  next();
}
