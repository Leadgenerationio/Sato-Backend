import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { sosHelpRequests } from '../db/schema/sos-help.js';
import { users } from '../db/schema/users.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// Slice 5 Day 6 (Sam Loom #100). The SOS button does two things:
//   1. Records the request so Sam can see who's stuck — even if the user
//      never actually hits "send" inside WhatsApp.
//   2. Returns a `wa.me/<number>?text=<prefilled>` deep link the frontend
//      opens. We don't have a WhatsApp Business API account yet, so this
//      uses the user's own WhatsApp to send the message. Honest: it opens
//      a draft, it does not send.

export interface SosHelpRequest {
  id: string;
  userId: string | null;
  pagePath: string | null;
  message: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  // Joined display fields (optional — only populated by the list endpoint).
  userName?: string | null;
  userEmail?: string | null;
}

export interface CreateSosResult {
  request: SosHelpRequest;
  whatsappLink: string;
  recipientNumber: string | null; // null if not configured — FE can fall back to "Sam hasn't set this up yet"
}

type SosRow = typeof sosHelpRequests.$inferSelect;

function rowToDto(row: SosRow, joined?: { userName?: string | null; userEmail?: string | null }): SosHelpRequest {
  return {
    id: row.id,
    userId: row.userId,
    pagePath: row.pagePath,
    message: row.message,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    userName: joined?.userName ?? null,
    userEmail: joined?.userEmail ?? null,
  };
}

// Strip everything that isn't a digit. wa.me requires the international
// format with NO `+` or spaces (e.g. `447700900123`).
function normaliseWhatsAppNumber(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

function buildWhatsAppLink(numberDigits: string, prefilledText: string): string {
  // Encode as URI component for safe transport (newlines etc.).
  const encoded = encodeURIComponent(prefilledText);
  return `https://wa.me/${numberDigits}?text=${encoded}`;
}

function buildPrefilledMessage(opts: {
  userLabel: string;
  pagePath?: string | null;
  message?: string | null;
}): string {
  const lines = [`🚨 Stato SOS — ${opts.userLabel}`];
  if (opts.pagePath) lines.push(`Page: ${opts.pagePath}`);
  if (opts.message && opts.message.trim()) {
    lines.push('');
    lines.push(opts.message.trim());
  } else {
    lines.push('');
    lines.push("I'm stuck and need a hand.");
  }
  return lines.join('\n');
}

export async function createSosRequest(
  requester: AuthPayload,
  input: { pagePath?: string; message?: string },
): Promise<CreateSosResult> {
  // Best-effort look up the user's display name. The auth payload has email
  // and userId already; we want a friendlier "from" label in the WA message.
  const [row] = await db
    .insert(sosHelpRequests)
    .values({
      userId: requester.userId ?? null,
      pagePath: input.pagePath ?? null,
      message: input.message ?? null,
    })
    .returning();

  // Pull a friendly name for the WhatsApp message; fall back to email.
  let userLabel = requester.email;
  if (requester.userId) {
    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, requester.userId));
    if (u?.name) userLabel = u.name;
    else if (u?.email) userLabel = u.email;
  }

  // Read process.env at runtime (not env.SOS_WHATSAPP_NUMBER which is
  // captured at module-init) so tests can toggle the number per case
  // and an operator can rotate it without bouncing the process.
  const raw = process.env.SOS_WHATSAPP_NUMBER;
  let recipientNumber: string | null = null;
  let whatsappLink = '';
  if (raw && raw.trim()) {
    recipientNumber = normaliseWhatsAppNumber(raw);
    if (recipientNumber.length < 7) {
      // Config exists but looks bogus — treat as unconfigured.
      logger.warn({ raw }, 'SOS_WHATSAPP_NUMBER looks invalid');
      recipientNumber = null;
    } else {
      whatsappLink = buildWhatsAppLink(
        recipientNumber,
        buildPrefilledMessage({ userLabel, pagePath: input.pagePath, message: input.message }),
      );
    }
  } else {
    logger.warn('SOS request recorded but SOS_WHATSAPP_NUMBER not configured');
  }

  return { request: rowToDto(row), whatsappLink, recipientNumber };
}

export async function listSosRequests(
  opts: { unresolvedOnly?: boolean; limit?: number } = {},
): Promise<SosHelpRequest[]> {
  const limit = opts.limit ?? 50;
  const rows = await db
    .select({
      req: sosHelpRequests,
      userName: users.name,
      userEmail: users.email,
    })
    .from(sosHelpRequests)
    .leftJoin(users, eq(users.id, sosHelpRequests.userId))
    .orderBy(desc(sosHelpRequests.createdAt))
    .limit(limit);

  let dtos = rows.map((r) => rowToDto(r.req, { userName: r.userName, userEmail: r.userEmail }));
  if (opts.unresolvedOnly) dtos = dtos.filter((r) => !r.resolvedAt);
  return dtos;
}

export async function resolveSosRequest(
  id: string,
  resolver: AuthPayload,
): Promise<SosHelpRequest | null> {
  const [row] = await db
    .update(sosHelpRequests)
    .set({ resolvedAt: new Date(), resolvedBy: resolver.userId ?? null })
    .where(eq(sosHelpRequests.id, id))
    .returning();
  if (!row) return null;
  return rowToDto(row);
}
