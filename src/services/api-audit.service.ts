import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiAuditLog } from '../db/schema/api-audit-log.js';
import { apiKeys, type ApiKeyRow } from '../db/schema/api-keys.js';
import { hashKey, KEY_MARKER } from './api-key.service.js';
import { logger } from '../utils/logger.js';

// MCP spec v1.0 §3 audit log (step 1g): one row per API-key call, REST and
// MCP, with the key, the user who owns it, the bot name, the tool, the
// arguments (secrets and file bytes removed), the result, the error code, the
// records touched and before/after for changes. MCP tools hand their part
// over in res.locals.audit (plan contract "Audit"); REST routes are logged
// from the request and the response. Writing never fails the call.

export const REDACTED = '[redacted]';

/** Field names whose values are never stored. */
const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key|authori[sz]ation|signature|cookie|credential|private[-_]?key/i;
/** Query parameters that make a URL a credential (presigned R2/S3/GCS links, signed webhooks, key-in-URL APIs). */
const SIGNED_PARAM = /^(x-amz-.*|x-goog-.*|sig|signature|token|access_token|id_token|key|apikey|api_key|auth|jwt|expires|googleaccessid|client_secret)$/i;
/** A Stato key anywhere in a string: a pasted note, `Bearer stk_…`, a URL. */
const KEY_ANYWHERE = new RegExp(`${KEY_MARKER}[A-Za-z0-9_-]{20,}`, 'g');
const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
/** Per JSON column. Anything larger is replaced by a marker with its size. */
const MAX_JSON_BYTES = 16 * 1024;

function redactString(s: string): string {
  if (s.startsWith(KEY_MARKER)) return REDACTED;
  s = s.replace(KEY_ANYWHERE, REDACTED);
  if (/^https?:\/\//i.test(s) && s.includes('?')) {
    try {
      const u = new URL(s);
      for (const name of [...u.searchParams.keys()]) if (SIGNED_PARAM.test(name)) u.searchParams.set(name, REDACTED);
      s = u.toString();
    } catch { /* not a URL after all */ }
  }
  // File bytes, base64 and other blobs: keep the size, not the content.
  return s.length > MAX_STRING ? `[${s.length} characters]` : s;
}

/** A copy of value that is safe to store: secrets masked, blobs and long lists cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** redact() plus the size cap of one JSON column. */
export function auditJson(value: unknown): unknown {
  if (value === undefined) return null;
  const safe = redact(value);
  const bytes = Buffer.byteLength(JSON.stringify(safe) ?? '');
  return bytes > MAX_JSON_BYTES ? { truncated: true, bytes } : safe;
}

/** What an MCP tool hands over in res.locals.audit (src/mcp/server.ts AuditEntry). */
interface ToolAudit {
  tool?: string;
  args?: unknown;
  before?: unknown;
  after?: unknown;
  recordsTouched?: Array<{ type: string; id: string }>;
  errorCode?: string;
}

type KeyForAudit = Pick<ApiKeyRow, 'id' | 'businessId' | 'name' | 'createdBy' | 'agentLabel'>;

const isMcp = (req: Request) => req.originalUrl.split('?')[0]!.startsWith('/mcp');

/** The audit row for one finished call. Exported for tests. */
export function buildAuditRow(key: KeyForAudit, req: Request, res: Response, startedAt: number): typeof apiAuditLog.$inferInsert {
  const entry = res.locals.audit as ToolAudit | undefined;
  const mcp = isMcp(req);
  const rpc = mcp && req.body && typeof req.body === 'object' ? (req.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }) : null;
  // A tools/call the SDK refused before the tool ran (bad input) leaves no entry; the name is still in the request.
  const tool = entry?.tool ?? (rpc?.method === 'tools/call' && typeof rpc.params?.name === 'string' ? rpc.params.name : null);
  // The rate limiter answers 429 without a code; other bodies without one keep their status.
  const fallback = res.statusCode === 429 ? 'rate_limited' : res.statusCode >= 400 ? `http_${res.statusCode}` : null;
  const errorCode = entry?.errorCode ?? (res.locals.auditErrorCode as string | undefined) ?? fallback;
  const args = entry
    ? entry.args
    : mcp
      ? { method: rpc?.method ?? null, ...(rpc?.params?.arguments !== undefined ? { arguments: rpc.params.arguments } : {}) }
      : { query: req.query, ...(req.body !== undefined && Object.keys(req.body ?? {}).length ? { body: req.body } : {}) };
  const agent = (req.get('x-stato-agent') ?? '').trim().slice(0, 100) || key.agentLabel || null;

  return {
    businessId: key.businessId,
    apiKeyId: key.id,
    keyName: key.name.slice(0, 100),
    ownerUserId: key.createdBy ?? null,
    agent,
    mcpSessionId: (req.get('mcp-session-id') ?? '').slice(0, 100) || null,
    requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId.slice(0, 64) : null,
    ip: (req.ip ?? '').slice(0, 45) || null,
    transport: mcp ? 'mcp' : 'rest',
    tool: tool ? tool.slice(0, 100) : null,
    method: req.method.slice(0, 8),
    path: req.originalUrl.split('?')[0]!.slice(0, 300),
    status: res.statusCode,
    errorCode: errorCode ? errorCode.slice(0, 60) : null,
    args: auditJson(args),
    result: errorCode ? { outcome: 'error', code: errorCode } : { outcome: 'ok' },
    recordsTouched: entry?.recordsTouched ? auditJson(entry.recordsTouched) : null,
    before: entry && entry.before !== undefined ? auditJson(entry.before) : null,
    after: entry && entry.after !== undefined ? auditJson(entry.after) : null,
    durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
  };
}

/** Fire-and-forget: an audit failure is logged, never returned to the caller. */
export async function writeAuditRow(row: typeof apiAuditLog.$inferInsert): Promise<void> {
  try {
    await db.insert(apiAuditLog).values(row);
  } catch (err) {
    logger.warn({ err, requestId: row.requestId, apiKeyId: row.apiKeyId }, 'API audit row not written');
  }
}

/**
 * Record this call when the response is finished. Also keeps the error code
 * the REST error body carries, so the row says why a call failed.
 */
export function auditOnFinish(key: KeyForAudit, req: Request, res: Response, startedAt = Date.now()): void {
  // One row per call, even if a router ever runs the key middleware twice.
  if (res.locals.auditArmed) return;
  res.locals.auditArmed = true;
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    const code = res.statusCode >= 400 && body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    if (typeof code === 'string') res.locals.auditErrorCode = code;
    return json(body);
  }) as Response['json'];
  onceDone(res, (finished) => {
    void (async () => {
      // The client went away before the answer was sent (a long upload, say): still one row.
      if (!finished && !res.locals.auditErrorCode) res.locals.auditErrorCode = 'client_closed';
      if (!res.locals.audit && !res.locals.auditErrorCode) {
        const code = await unrunToolCode(req);
        if (code) res.locals.auditErrorCode = code;
      }
      await writeAuditRow(buildAuditRow(key, req, res, startedAt));
    })();
  });
}

/**
 * Run fn once when the response ends: on 'finish' (sent), or on 'close'
 * without 'finish' (the client disconnected first). finished tells which.
 */
function onceDone(res: Response, fn: (finished: boolean) => void): void {
  let done = false;
  const fire = (finished: boolean) => { if (!done) { done = true; fn(finished); } };
  res.once('finish', () => fire(true));
  res.once('close', () => fire(res.writableFinished));
}

/**
 * A tools/call whose tool never ran leaves no res.locals.audit, and the SDK's
 * error goes out inside a 200 we don't read. Name the reason so the row isn't
 * logged as a success: an unknown tool is not_found; a known tool the SDK
 * refused before it ran had invalid input.
 */
async function unrunToolCode(req: Request): Promise<string | null> {
  if (!isMcp(req)) return null;
  const rpc = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  if (rpc?.method !== 'tools/call' || typeof rpc.params?.name !== 'string') return null;
  try {
    // Imported here: the registry loads every tool file, which the key middleware must not pull in at start-up.
    const { getTools } = await import('../mcp/tools/registry.js');
    const names = new Set((await getTools()).map((t) => t.name));
    return names.has(rpc.params.name) ? 'validation_failed' : 'not_found';
  } catch (err) {
    logger.warn({ err }, 'API audit could not load the MCP tool list');
    return null;
  }
}

/**
 * A key that exists but was refused (revoked, expired, owner deactivated):
 * still one row, so the Activity view shows the attempt (spec tests 10, 16).
 * A key Stato has never issued has no business to file it under; it goes to
 * the app log only.
 */
export async function auditRefusedKey(rawKey: string, req: Request, res: Response, startedAt = Date.now()): Promise<void> {
  try {
    const [key] = await db.select({ id: apiKeys.id, businessId: apiKeys.businessId, name: apiKeys.name, createdBy: apiKeys.createdBy, agentLabel: apiKeys.agentLabel })
      .from(apiKeys).where(eq(apiKeys.hash, hashKey(rawKey))).limit(1);
    if (!key) {
      // debug, not info: anyone can send random keys, one line each would flood the log.
      res.once('finish', () => logger.debug({ requestId: res.locals.requestId, path: req.originalUrl.split('?')[0], ip: req.ip }, 'Call with an unknown API key'));
      return;
    }
    if (res.locals.auditArmed) return;
    res.locals.auditArmed = true;
    res.locals.auditErrorCode = 'unauthorized';
    onceDone(res, () => { void writeAuditRow(buildAuditRow(key, req, res, startedAt)); });
  } catch (err) {
    logger.warn({ err }, 'API audit lookup for a refused key failed');
  }
}
