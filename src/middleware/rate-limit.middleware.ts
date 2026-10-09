import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';

// Active admin sessions easily exceed 100 req / 15 min:
// dashboard polls every 30s (~30 r/15m), LeadByte hooks poll every 90s
// (~10 r/15m), plus pagination, categorise clicks, and notification badge
// fetches. The previous 100/15m cap tripped Sam's bank-feed categorise
// flow with "Too many requests, please try again later". 1500/15m =
// ~100 rpm leaves comfortable headroom for normal use; abusive clients
// still hit the wall. Auth limiter stays tight (login brute-force).
/** Seconds until the caller may try again (the same number the Retry-After header carries). */
export function retryAfterSeconds(req: Request, windowMs: number): number {
  const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const ms = reset ? reset.getTime() - Date.now() : windowMs;
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * A 429 in the shared error shape (MCP spec v1.0 §3): code rate_limited,
 * retryable, retryAfter seconds and the request ID, next to the message the
 * portal already shows. On /mcp the same body goes in a JSON-RPC error, so an
 * MCP client sees it instead of a transport failure. express-rate-limit sets
 * the Retry-After header before calling this.
 */
export function rateLimitedHandler(message: string, hint: string): Options['handler'] {
  return (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const retryAfter = retryAfterSeconds(req, options.windowMs);
    const requestId = res.locals.requestId as string | undefined;
    const body = {
      status: 'error', code: 'rate_limited', message, hint, retryable: true, retryAfter,
      ...(requestId ? { requestId } : {}),
    };
    if (req.originalUrl.startsWith('/mcp')) {
      res.status(options.statusCode).json({ jsonrpc: '2.0', error: { code: -32000, message, data: body }, id: jsonRpcId(req.body) });
      return;
    }
    res.status(options.statusCode).json(body);
  };
}

/** The id of a single JSON-RPC request, so the client can match the error to its call; null for a batch or no body. */
export function jsonRpcId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const GENERAL_LIMIT_MAX = 1500;
export const AUTH_LIMIT_MAX = 20;

/** A request that carries an API key (`X-API-Key`, or `Authorization: Bearer stk_…` as MCP clients send it). */
export function isApiKeyRequest(req: Request): boolean {
  return Boolean(req.get('x-api-key')) || /^Bearer\s+stk_/i.test(req.get('authorization') ?? '');
}

/**
 * Only /mcp is exempt from the per-IP limit below: it takes API keys only, and every call there is limited per key
 * (120 a minute, apiKeyRateLimit). Anywhere else a key-shaped header proves nothing (any junk value would do), so
 * those routes keep the per-IP limit whatever headers they carry.
 */
export const isKeyOnlyRoute = (req: Request): boolean => { const path = req.originalUrl.split('?')[0]!; return path === '/mcp' || path === '/mcp/'; };

/**
 * The per-IP limit for people using the portal. The 1,500 per 15 minutes works out at 100 a minute, so a bot allowed
 * 120 a minute on /mcp would have been stopped by it after about 12 minutes, and several bots behind one address
 * would share it; /mcp is therefore limited per key instead.
 */
export const createGeneralLimiter = (max: number = GENERAL_LIMIT_MAX) => rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isKeyOnlyRoute(req) && isApiKeyRequest(req),
  handler: rateLimitedHandler('Too many requests, please try again later', 'Wait retryAfter seconds, then try again.'),
});
export const generalLimiter = createGeneralLimiter();

/**
 * What stands in for the per-IP limit on key traffic: guessing keys. Only calls refused as 401 (a key that is wrong,
 * expired or revoked) count, so a busy, well-behaved bot is never slowed down by this.
 */
export const KEY_FAILURE_LIMIT_MAX = 300;
export const createKeyFailureLimiter = (max: number = KEY_FAILURE_LIMIT_MAX) => rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isApiKeyRequest(req),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  handler: rateLimitedHandler('Too many requests with a wrong API key, please try again later', 'Check the key (it may be revoked or expired), then wait retryAfter seconds.'),
});
export const keyFailureLimiter = createKeyFailureLimiter();

export const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('Too many login attempts, please try again later', 'Wait retryAfter seconds before trying to sign in again.'),
});
