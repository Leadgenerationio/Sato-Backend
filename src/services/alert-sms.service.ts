import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { notifications } from '../db/schema/notifications.js';
import { logger } from '../utils/logger.js';
import * as twilio from '../integrations/twilio/twilio-client.js';

const BATCH_LIMIT = 20;
const COALESCE_THRESHOLD = 2;
const ATTEMPTS_CAP = 5;
const SMS_MAX_CHARS = 1500;

export interface PollResult {
  sent: number;
  failed: number;
}

/**
 * Single polling cycle: select unsent system_error rows, coalesce into one
 * SMS (or one summary if multiple), call Twilio, mark notified or bump
 * attempts on failure.
 *
 * Hard no-ops when not fully configured:
 *   - OPS_ALERT_PHONE missing → nothing to send to.
 *   - Twilio creds missing → would silently mark rows notified in mock mode
 *     and lose the backlog when real creds eventually arrive on Railway.
 *
 * Called every 30s from the `sync` BullMQ worker (case 'sms-alert-poll').
 *
 * NOTE: reads process.env.OPS_ALERT_PHONE directly (not via the frozen `env`
 * object) so that tests can set it in beforeEach after module import.
 * Mirrors the same pattern used in twilio-client.ts for TWILIO_* vars.
 */
export async function pollOnce(): Promise<PollResult> {
  // Read at call-time so test beforeEach mutations are visible.
  const opsPhone = process.env.OPS_ALERT_PHONE;

  if (!opsPhone) return { sent: 0, failed: 0 };
  if (!twilio.isTwilioConfigured()) return { sent: 0, failed: 0 };

  const rows = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.type, 'system_error'),
      isNull(notifications.smsNotifiedAt),
      lt(notifications.smsAttempts, ATTEMPTS_CAP),
    ))
    .orderBy(asc(notifications.createdAt))
    .limit(BATCH_LIMIT);

  if (rows.length === 0) return { sent: 0, failed: 0 };

  const mostRecent = rows[rows.length - 1];
  const body =
    rows.length < COALESCE_THRESHOLD
      ? `[Stato] ${mostRecent.title}\n${mostRecent.message ?? ''}`.slice(0, SMS_MAX_CHARS)
      : `[Stato] ${rows.length} system errors. Most recent: ${mostRecent.title}`;

  const ids = rows.map(r => r.id);

  try {
    await twilio.sendSms({ to: opsPhone, body });
    await db
      .update(notifications)
      .set({
        smsNotifiedAt: new Date(),
        smsAttempts: sql`${notifications.smsAttempts} + 1`,
      })
      .where(inArray(notifications.id, ids));
    return { sent: rows.length, failed: 0 };
  } catch (err) {
    logger.error({ err, ids }, 'SMS alert failed — bumping sms_attempts');
    await db
      .update(notifications)
      .set({ smsAttempts: sql`${notifications.smsAttempts} + 1` })
      .where(inArray(notifications.id, ids));
    return { sent: 0, failed: rows.length };
  }
}
