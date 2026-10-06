import { and, desc, eq, gte, isNotNull, isNull, lt, lte, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiAuditLog, type ApiAuditRow } from '../db/schema/api-audit-log.js';
import { users } from '../db/schema/users.js';

// Settings → API keys → Activity (MCP spec v1.0 §3, spec test 16): every
// API-key call with the bot name, the tool, the result and the records it
// touched. Newest first, paged by row ID so new calls never shift a page.

export const ACTIVITY_MAX_LIMIT = 200;

export interface ActivityFilters {
  keyId?: string;
  tool?: string;
  transport?: 'rest' | 'mcp';
  outcome?: 'ok' | 'error';
  errorCode?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  /** nextCursor from the previous page: rows older than this ID. */
  cursor?: string;
}

export interface ActivityRow {
  id: string;
  at: string;
  keyId: string | null;
  keyName: string | null;
  owner: string | null;
  agent: string | null;
  transport: string;
  tool: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  errorCode: string | null;
  result: unknown;
  args: unknown;
  recordsTouched: unknown;
  before: unknown;
  after: unknown;
  durationMs: number | null;
  requestId: string | null;
  ip: string | null;
}

const toRow = (r: ApiAuditRow, owner: string | null): ActivityRow => ({
  id: String(r.id),
  at: r.at.toISOString(),
  keyId: r.apiKeyId ?? null,
  keyName: r.keyName ?? null,
  owner,
  agent: r.agent ?? null,
  transport: r.transport,
  tool: r.tool ?? null,
  method: r.method ?? null,
  path: r.path ?? null,
  status: r.status ?? null,
  errorCode: r.errorCode ?? null,
  result: r.result ?? null,
  args: r.args ?? null,
  recordsTouched: r.recordsTouched ?? null,
  before: r.before ?? null,
  after: r.after ?? null,
  durationMs: r.durationMs ?? null,
  requestId: r.requestId ?? null,
  ip: r.ip ?? null,
});

/** One page of the business's API activity. Arguments were redacted when the row was written. */
export async function listApiActivity(businessId: string, f: ActivityFilters = {}): Promise<{ items: ActivityRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), ACTIVITY_MAX_LIMIT);
  const where: SQL[] = [eq(apiAuditLog.businessId, businessId)];
  if (f.keyId) where.push(eq(apiAuditLog.apiKeyId, f.keyId));
  if (f.tool) where.push(eq(apiAuditLog.tool, f.tool));
  if (f.transport) where.push(eq(apiAuditLog.transport, f.transport));
  if (f.outcome === 'ok') where.push(isNull(apiAuditLog.errorCode));
  if (f.outcome === 'error') where.push(isNotNull(apiAuditLog.errorCode));
  if (f.errorCode) where.push(eq(apiAuditLog.errorCode, f.errorCode));
  if (f.from) where.push(gte(apiAuditLog.at, f.from));
  if (f.to) where.push(lte(apiAuditLog.at, f.to));
  if (f.cursor) where.push(lt(apiAuditLog.id, Number(f.cursor)));

  const rows = await db
    .select({ row: apiAuditLog, owner: users.name })
    .from(apiAuditLog)
    .leftJoin(users, eq(users.id, apiAuditLog.ownerUserId))
    .where(and(...where))
    .orderBy(desc(apiAuditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => toRow(r.row, r.owner ?? null)),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.row.id) : null,
  };
}
