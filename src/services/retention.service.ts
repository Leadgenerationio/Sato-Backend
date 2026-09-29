import { sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

// Idempotency replays are only honoured for 24 h (api-key.middleware.ts), so
// older rows are dead weight. Usage log is kept 90 days for the key's
// "last used / recent calls" view.
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const API_USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH = 5000;
const MAX_BATCHES = 200; // 1M rows per table per run; the rest goes tomorrow

/** Delete in bounded batches so a first run over a huge table never holds one giant transaction. */
async function purgeBatched(table: 'idempotency_keys' | 'api_key_usage', column: 'created_at' | 'at', cutoff: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await db.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE ctid IN (
        SELECT ctid FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} < ${cutoff.toISOString()}::timestamptz
        LIMIT ${BATCH}
      )`);
    const n = Number((res as { rowCount?: number | null }).rowCount ?? 0);
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

export async function purgeApiHousekeeping(now = new Date()) {
  const idempotencyKeys = await purgeBatched('idempotency_keys', 'created_at', new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS));
  const apiKeyUsage = await purgeBatched('api_key_usage', 'at', new Date(now.getTime() - API_USAGE_RETENTION_MS));
  logger.info({ idempotencyKeys, apiKeyUsage }, 'API housekeeping purge done');
  return { idempotencyKeys, apiKeyUsage };
}
