import { desc, eq, and } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientEmails } from '../db/schema/client-emails.js';
import { logClientActivity } from './client-activity.service.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// L #33 — client email thread. CRUD + listing. Writes a row to the
// activity log so the feed surfaces every email.

export interface ClientEmail {
  id: string;
  clientId: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  body: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  messageId: string | null;
  resendEvent: string | null;
  occurredAt: string;
  loggedBy: string | null;
  createdAt: string;
}

type EmailRow = typeof clientEmails.$inferSelect;

function toDto(row: EmailRow): ClientEmail {
  return {
    id: row.id,
    clientId: row.clientId,
    direction: row.direction as 'inbound' | 'outbound',
    subject: row.subject,
    body: row.body,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    messageId: row.messageId,
    resendEvent: row.resendEvent,
    occurredAt: row.occurredAt.toISOString(),
    loggedBy: row.loggedBy,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

export interface CreateClientEmailInput {
  direction: 'inbound' | 'outbound';
  subject?: string;
  body?: string;
  fromAddress?: string;
  toAddress?: string;
  messageId?: string;
  resendEvent?: string;
  occurredAt?: string;
}

export async function listClientEmails(
  clientId: string,
  opts: { limit?: number; direction?: 'inbound' | 'outbound' } = {},
): Promise<ClientEmail[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const conds = [eq(clientEmails.clientId, clientId)];
  if (opts.direction) conds.push(eq(clientEmails.direction, opts.direction));
  const rows = await db
    .select()
    .from(clientEmails)
    .where(and(...conds))
    .orderBy(desc(clientEmails.occurredAt))
    .limit(limit);
  return rows.map(toDto);
}

export async function logClientEmail(
  clientId: string,
  input: CreateClientEmailInput,
  requester: AuthPayload | null,
): Promise<ClientEmail> {
  const [row] = await db
    .insert(clientEmails)
    .values({
      clientId,
      direction: input.direction,
      subject: input.subject ?? null,
      body: input.body ?? null,
      fromAddress: input.fromAddress ?? null,
      toAddress: input.toAddress ?? null,
      messageId: input.messageId ?? null,
      resendEvent: input.resendEvent ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      loggedBy: requester?.userId ?? null,
    })
    .returning();

  // Activity feed surface — direction-aware event type so the feed can
  // render distinct icons / language for inbound vs outbound.
  await logClientActivity(
    clientId,
    requester?.userId ?? null,
    input.direction === 'inbound' ? 'email_logged_inbound' : 'email_logged_outbound',
    {
      emailId: row.id,
      subject: row.subject,
      from: row.fromAddress,
      to: row.toAddress,
    },
  );

  return toDto(row);
}

export async function deleteClientEmail(
  clientId: string,
  emailId: string,
  requester: AuthPayload,
): Promise<boolean> {
  // Scope to the client_id so a user can't accidentally remove another
  // client's email by guessing IDs.
  const [row] = await db
    .delete(clientEmails)
    .where(and(eq(clientEmails.id, emailId), eq(clientEmails.clientId, clientId)))
    .returning();
  if (!row) return false;
  await logClientActivity(clientId, requester.userId ?? null, 'email_removed', {
    emailId: row.id,
    subject: row.subject,
  });
  return true;
}

// Convenience helper used by the Resend integration to drop an outbound
// row when an email is sent on behalf of a client. Failure here is
// non-fatal — we don't want a logging hiccup to break the actual send.
export async function recordOutboundEmail(
  clientId: string,
  args: {
    subject?: string;
    body?: string;
    fromAddress?: string;
    toAddress?: string;
    messageId?: string;
  },
): Promise<void> {
  try {
    await logClientEmail(clientId, {
      direction: 'outbound',
      ...args,
    }, null);
  } catch (err) {
    logger.warn({ err, clientId }, 'Failed to record outbound client email');
  }
}

