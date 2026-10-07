import { pgTable, uuid, varchar, integer, bigserial, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses.js';
import { users } from './users.js';
import { apiKeys } from './api-keys.js';

// Migration 0055 (MCP connector). One row per API / MCP call. api_key_usage
// only keeps method, path and status; this keeps who, what, and what changed.
// Arguments are stored redacted. 12-month retention (purged by housekeeping).
export const apiAuditLog = pgTable('api_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id).notNull(),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  keyName: varchar('key_name', { length: 100 }),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Bot name from the X-Stato-Agent header. */
  agent: varchar('agent', { length: 100 }),
  mcpSessionId: varchar('mcp_session_id', { length: 100 }),
  requestId: varchar('request_id', { length: 64 }),
  ip: varchar('ip', { length: 45 }),
  /** rest | mcp. */
  transport: varchar('transport', { length: 4 }).notNull().default('rest'),
  tool: varchar('tool', { length: 100 }),
  method: varchar('method', { length: 8 }),
  path: varchar('path', { length: 300 }),
  status: integer('status'),
  errorCode: varchar('error_code', { length: 60 }),
  args: jsonb('args'),
  result: jsonb('result'),
  recordsTouched: jsonb('records_touched'),
  before: jsonb('before'),
  after: jsonb('after'),
  durationMs: integer('duration_ms'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('api_audit_log_business_at_idx').on(t.businessId, t.at),
  index('api_audit_log_key_at_idx').on(t.apiKeyId, t.at),
  index('api_audit_log_at_idx').on(t.at),
  // Per-creative history (0057): records_touched @> '[{"type":"creative","id":…}]'.
  index('api_audit_log_records_touched_idx').using('gin', sql`${t.recordsTouched} jsonb_path_ops`),
]);

export type ApiAuditRow = typeof apiAuditLog.$inferSelect;
