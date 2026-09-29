import { lt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { idempotencyKeys, apiKeyUsage } from '../db/schema/api-keys.js';
import { logger } from '../utils/logger.js';

// Idempotency replays are only honoured for 24 h (api-key.middleware.ts), so
// older rows are dead weight. Usage log is kept 90 days for the key's
// "last used / recent calls" view.
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const API_USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function purgeApiHousekeeping(now = new Date()) {
  const idem = await db.delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS)))
    .returning({ key: idempotencyKeys.key });
  const usage = await db.delete(apiKeyUsage)
    .where(lt(apiKeyUsage.at, new Date(now.getTime() - API_USAGE_RETENTION_MS)))
    .returning({ id: apiKeyUsage.id });
  logger.info({ idempotencyKeys: idem.length, apiKeyUsage: usage.length }, 'API housekeeping purge done');
  return { idempotencyKeys: idem.length, apiKeyUsage: usage.length };
}
