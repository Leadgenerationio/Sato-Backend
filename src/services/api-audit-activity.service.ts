import { and, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { apiAuditLog, type ApiAuditRow } from '../db/schema/api-audit-log.js';
import { users } from '../db/schema/users.js';
import { csvCell } from '../utils/csv.js';

// Settings → API keys → Activity (MCP spec v1.0 §3, spec test 16): every
// API-key call with the bot name, the tool, the result and the records it
// touched. Newest first by (at, id), so the (business_id, at) and
// (api_key_id, at) indexes serve the filters; paged by that pair, so new
// calls never shift a page.

export const ACTIVITY_MAX_LIMIT = 200;

export interface ActivityFilters {
  keyId?: string;
  tool?: string;
  transport?: 'rest' | 'mcp';
  outcome?: 'ok' | 'error';
  errorCode?: string;
  /** Only calls that touched this creative (records_touched, GIN index 0057). */
  creativeId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  /** nextCursor from the previous page: `<at in epoch microseconds>.<id>`, rows older than that. */
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
  return queryActivity(businessId, f, Math.min(Math.max(f.limit ?? 50, 1), ACTIVITY_MAX_LIMIT));
}

function activityWhere(businessId: string, f: ActivityFilters): SQL[] {
  const where: SQL[] = [eq(apiAuditLog.businessId, businessId)];
  if (f.keyId) where.push(eq(apiAuditLog.apiKeyId, f.keyId));
  if (f.tool) where.push(eq(apiAuditLog.tool, f.tool));
  if (f.transport) where.push(eq(apiAuditLog.transport, f.transport));
  if (f.outcome === 'ok') where.push(isNull(apiAuditLog.errorCode));
  if (f.outcome === 'error') where.push(isNotNull(apiAuditLog.errorCode));
  if (f.errorCode) where.push(eq(apiAuditLog.errorCode, f.errorCode));
  // records_touched holds ids as text, lowercase like Postgres prints a uuid; @> compares text exactly.
  if (f.creativeId) where.push(sql`${apiAuditLog.recordsTouched} @> ${JSON.stringify([{ type: 'creative', id: f.creativeId.toLowerCase() }])}::jsonb`);
  if (f.from) where.push(gte(apiAuditLog.at, f.from));
  if (f.to) where.push(lte(apiAuditLog.at, f.to));
  if (f.cursor) {
    // Microseconds and the ID stay integers end to end (Number keeps 15 digits
    // exactly, the route allows no more), so no row is skipped or repeated.
    const [micros, id] = f.cursor.split('.') as [string, string];
    where.push(sql`(${apiAuditLog.at}, ${apiAuditLog.id}) < (timestamptz 'epoch' + ${micros}::bigint * interval '1 microsecond', ${Number(id)})`);
  }
  return where;
}

const atMicros = sql<string>`(extract(epoch from ${apiAuditLog.at}) * 1000000)::bigint::text`;

async function queryActivity(businessId: string, f: ActivityFilters, limit: number): Promise<{ items: ActivityRow[]; nextCursor: string | null }> {
  const rows = await db
    .select({ row: apiAuditLog, owner: users.name, atMicros })
    .from(apiAuditLog)
    .leftJoin(users, eq(users.id, apiAuditLog.ownerUserId))
    .where(and(...activityWhere(businessId, f)))
    .orderBy(desc(apiAuditLog.at), desc(apiAuditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => toRow(r.row, r.owner ?? null)),
    nextCursor: rows.length > limit ? `${page[page.length - 1]!.atMicros}.${page[page.length - 1]!.row.id}` : null,
  };
}

// CSV export (spec D9): the same filters as the list, newest first, one sheet.
export const ACTIVITY_EXPORT_LIMIT = 10_000;
const EXPORT_PAGE = 1_000;

const csvFields = {
  at: apiAuditLog.at, keyName: apiAuditLog.keyName, owner: users.name, agent: apiAuditLog.agent, transport: apiAuditLog.transport,
  tool: apiAuditLog.tool, method: apiAuditLog.method, path: apiAuditLog.path, status: apiAuditLog.status, errorCode: apiAuditLog.errorCode,
  recordsTouched: apiAuditLog.recordsTouched, durationMs: apiAuditLog.durationMs, requestId: apiAuditLog.requestId, ip: apiAuditLog.ip,
  id: apiAuditLog.id, atMicros,
};
type CsvRow = { at: Date; recordsTouched: unknown } & Record<'keyName' | 'owner' | 'agent' | 'tool' | 'method' | 'path' | 'errorCode' | 'requestId' | 'ip', string | null>
  & { transport: string; status: number | null; durationMs: number | null };

const CSV_COLUMNS: Array<[string, (r: CsvRow) => string | number]> = [
  ['Time (UTC)', (r) => r.at.toISOString()],
  ['Key', (r) => r.keyName ?? ''],
  ['Key owner', (r) => r.owner ?? ''],
  ['Bot', (r) => r.agent ?? ''],
  ['Transport', (r) => r.transport],
  ['Tool', (r) => r.tool ?? ''],
  ['Method', (r) => r.method ?? ''],
  ['Path', (r) => r.path ?? ''],
  ['HTTP status', (r) => r.status ?? ''],
  ['Result', (r) => r.errorCode ?? 'ok'],
  ['Records touched', (r) => (Array.isArray(r.recordsTouched) ? (r.recordsTouched as Array<{ type: string; id: string }>).map((t) => `${t.type}:${t.id}`).join(' ') : '')],
  ['Duration (ms)', (r) => r.durationMs ?? ''],
  ['Request ID', (r) => r.requestId ?? ''],
  ['IP', (r) => r.ip ?? ''],
];
const csvLine = (cells: Array<string | number>) => cells.map(csvCell).join(',') + '\r\n';

/**
 * The export, ready to stream: how many rows it will hold (for X-Row-Count, sent
 * before the body) and the CSV text in pages of EXPORT_PAGE, so at most one page
 * is in memory. Only the sheet's columns are read: arguments and before/after
 * stay in the Activity view. Calls made after the export started are left out,
 * so the count and the rows agree.
 */
export async function exportApiActivityCsv(businessId: string, f: Omit<ActivityFilters, 'limit' | 'cursor'> = {}): Promise<{ count: number; truncated: boolean; chunks: AsyncGenerator<string> }> {
  const startedAt = new Date();
  const filters: ActivityFilters = { ...f, to: f.to && f.to < startedAt ? f.to : startedAt };
  const counted = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from (select 1 from ${apiAuditLog} where ${and(...activityWhere(businessId, filters))} limit ${ACTIVITY_EXPORT_LIMIT + 1}) t`,
  );
  const total = Number((counted as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  const count = Math.min(total, ACTIVITY_EXPORT_LIMIT);

  async function* chunks(): AsyncGenerator<string> {
    yield csvLine(CSV_COLUMNS.map(([h]) => h));
    let cursor: string | undefined;
    for (let sent = 0; sent < count;) {
      const rows = await db.select(csvFields).from(apiAuditLog)
        .leftJoin(users, eq(users.id, apiAuditLog.ownerUserId))
        .where(and(...activityWhere(businessId, { ...filters, cursor })))
        .orderBy(desc(apiAuditLog.at), desc(apiAuditLog.id))
        .limit(Math.min(EXPORT_PAGE, count - sent));
      if (!rows.length) return;
      yield rows.map((r) => csvLine(CSV_COLUMNS.map(([, get]) => get(r)))).join('');
      sent += rows.length;
      const last = rows[rows.length - 1]!;
      cursor = `${last.atMicros}.${last.id}`;
    }
  }
  return { count, truncated: total > ACTIVITY_EXPORT_LIMIT, chunks: chunks() };
}
