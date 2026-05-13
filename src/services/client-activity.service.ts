import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientActivityLog } from '../db/schema/client-activity.js';
import { users } from '../db/schema/users.js';
import { logger } from '../utils/logger.js';

// L #38 — full activity feed. Mirrors the task_activity pattern.
// `logActivity` swallows errors because the feed is non-critical: a
// failed write here must never break the caller's main operation
// (uploading a document, signing an agreement, etc).

export interface ClientActivityEvent {
  id: string;
  clientId: string;
  actorUserId: string | null;
  actorName: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export async function logClientActivity(
  clientId: string,
  actorUserId: string | null,
  eventType: string,
  payload?: unknown,
): Promise<void> {
  try {
    await db.insert(clientActivityLog).values({
      clientId,
      actorUserId,
      eventType,
      payload: payload === undefined ? null : (payload as object),
    });
  } catch (err) {
    // Never fail the caller's main op because the activity log write
    // hiccuped. Surface in logs so we can spot pattern issues.
    logger.warn({ err, clientId, eventType }, 'Failed to write client activity event');
  }
}

export async function listClientActivity(
  clientId: string,
  opts: { limit?: number } = {},
): Promise<ClientActivityEvent[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const rows = await db
    .select({
      ev: clientActivityLog,
      actorName: users.name,
    })
    .from(clientActivityLog)
    .leftJoin(users, eq(users.id, clientActivityLog.actorUserId))
    .where(eq(clientActivityLog.clientId, clientId))
    .orderBy(desc(clientActivityLog.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.ev.id,
    clientId: r.ev.clientId,
    actorUserId: r.ev.actorUserId,
    actorName: r.actorName,
    eventType: r.ev.eventType,
    payload: r.ev.payload,
    createdAt: (r.ev.createdAt ?? new Date()).toISOString(),
  }));
}
