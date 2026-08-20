import { eq, desc, and, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { emailDeliveries, clientEmails } from '../db/schema/index.js';
import { logger } from '../utils/logger.js';

// Resend event -> our coarse status, with a rank so `status` only ever moves
// forward. Webhooks arrive out of order (a retried 'email.sent' can land after
// 'email.delivered'), so without ranking a late replay would downgrade a good
// delivery back to 'sent'.
//
// Failure states rank highest deliberately: a bounce or complaint is the
// diagnostic signal we actually care about and must never be masked by a
// subsequent engagement event.
const EVENT_RANK: Record<string, { status: string; rank: number }> = {
  'email.sent': { status: 'sent', rank: 10 },
  'email.delivery_delayed': { status: 'delayed', rank: 20 },
  'email.delivered': { status: 'delivered', rank: 30 },
  'email.opened': { status: 'opened', rank: 40 },
  'email.clicked': { status: 'clicked', rank: 50 },
  'email.complained': { status: 'complained', rank: 90 },
  'email.bounced': { status: 'bounced', rank: 91 },
  'email.failed': { status: 'failed', rank: 92 },
};

export function rankOf(status: string): number {
  const hit = Object.values(EVENT_RANK).find((e) => e.status === status);
  return hit ? hit.rank : 0;
}

export function mapEvent(type: string): { status: string; rank: number } | null {
  return EVENT_RANK[type] ?? null;
}

/**
 * Called from sendEmail() after Resend returns a message id. Best-effort:
 * a ledger write must never break the actual send.
 */
export async function recordSend(row: {
  messageId: string;
  toAddress: string;
  fromAddress?: string;
  subject?: string;
  kind?: string;
}): Promise<void> {
  try {
    await db
      .insert(emailDeliveries)
      .values({
        messageId: row.messageId,
        toAddress: row.toAddress.trim().toLowerCase(),
        fromAddress: row.fromAddress ?? null,
        subject: row.subject ?? null,
        kind: row.kind ?? null,
        status: 'sent',
      })
      // Re-sending is an explicit admin action ("Send welcome" again) and
      // Resend mints a fresh id each time, so a conflict here means a replay
      // of the same message — keep the existing row and its event history.
      .onConflictDoNothing({ target: emailDeliveries.messageId });
  } catch (err) {
    logger.warn({ err, messageId: row.messageId }, 'email_deliveries insert failed (send itself succeeded)');
  }
}

/**
 * Apply one Resend webhook event. Idempotent and order-independent — an event
 * whose rank is not higher than what we already stored is ignored.
 */
export async function applyEvent(payload: {
  type?: string;
  data?: { email_id?: string; to?: string | string[]; bounce?: { type?: string; message?: string } };
}): Promise<{ applied: boolean; reason?: string }> {
  const type = payload.type ?? '';
  const messageId = payload.data?.email_id ?? '';
  const mapped = mapEvent(type);

  if (!messageId) return { applied: false, reason: 'no email_id in payload' };
  if (!mapped) return { applied: false, reason: `unhandled event type "${type}"` };

  const [existing] = await db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.messageId, messageId));

  if (!existing) {
    // Event for a message we never recorded (sent before this table existed,
    // or sent by another environment sharing the Resend key). Log and move on
    // rather than inventing a half-populated row.
    logger.info({ messageId, type }, 'Resend event for unknown message id — ignoring');
    return { applied: false, reason: 'unknown message id' };
  }

  if (mapped.rank <= rankOf(existing.status)) {
    return { applied: false, reason: `stale event (${type} <= ${existing.status})` };
  }

  const isFailure = mapped.rank >= 90;
  await db
    .update(emailDeliveries)
    .set({
      status: mapped.status,
      lastEvent: type,
      lastEventAt: new Date(),
      updatedAt: new Date(),
      failureType: isFailure ? (payload.data?.bounce?.type ?? mapped.status) : existing.failureType,
      failureReason: isFailure ? (payload.data?.bounce?.message ?? null) : existing.failureReason,
    })
    .where(eq(emailDeliveries.messageId, messageId));

  // client_emails.resend_event has existed since L #33 for exactly this
  // ("handy for cross-referencing if we ever wire delivery/open events back
  // in") — populate it now that we have the events.
  try {
    await db
      .update(clientEmails)
      .set({ resendEvent: mapped.status })
      .where(eq(clientEmails.messageId, messageId));
  } catch (err) {
    logger.warn({ err, messageId }, 'client_emails.resend_event update failed');
  }

  if (isFailure) {
    logger.error(
      { messageId, type, to: existing.toAddress, failureType: payload.data?.bounce?.type },
      'Outbound email FAILED — recipient did not receive it',
    );
  }
  return { applied: true };
}

/** Most recent delivery record for an address (case-insensitive). */
export async function getLatestForEmail(email: string) {
  const [row] = await db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.toAddress, email.trim().toLowerCase()))
    .orderBy(desc(emailDeliveries.sentAt))
    .limit(1);
  return row ?? null;
}

/**
 * Full send history for an address, newest first. Powers the "why didn't they
 * get it?" drill-down on the Portal Users card.
 */
export async function listForEmail(email: string, limit = 10) {
  return db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.toAddress, email.trim().toLowerCase()))
    .orderBy(desc(emailDeliveries.sentAt))
    .limit(limit);
}

/**
 * Accepted by Resend but no delivery confirmation after `minutes`. This is the
 * Barry case: Microsoft 365 quarantined the message silently, so there is no
 * bounce event to catch — the ONLY signal is a 'sent' that never became
 * 'delivered'. Treat that as suspected-filtered rather than success.
 */
export async function listStuckSends(minutes = 15) {
  return db
    .select()
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.status, 'sent'),
        sql`${emailDeliveries.sentAt} < now() - (${minutes} * interval '1 minute')`,
      ),
    )
    .orderBy(desc(emailDeliveries.sentAt))
    .limit(200);
}
