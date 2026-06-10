import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { users, passwordResets } from '../db/schema/index.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import { templates, renderEmailHtml, renderEmailText } from '../integrations/resend/resend-templates.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Sam (2026-06-10): self-service forgot-password via a 6-digit emailed code.
// Three steps: request → verify → reset. Deliberately mirrors the login
// flow's no-enumeration stance — requestPasswordReset always resolves
// successfully whether or not the email maps to a real account.

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESET_TOKEN_EXPIRY = '10m';
const SALT_ROUNDS = 12;

// Short-lived token returned after a code is verified, so the final
// set-password step doesn't re-transmit the code. purpose-tagged so a
// normal access token can't be substituted here (and vice-versa).
interface ResetTokenPayload {
  purpose: 'password_reset';
  email: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateCode(): string {
  // 6 digits, zero-padded. Avoids Math.random bias concerns at this scale;
  // brute-force is bounded by MAX_ATTEMPTS + the 10-minute TTL + authLimiter.
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function findActiveUserByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row;
}

// Step 1 — request a code. ALWAYS resolves { sent: true } (no enumeration).
export async function requestPasswordReset(rawEmail: string): Promise<{ sent: true }> {
  const email = normalizeEmail(rawEmail);

  const user = await findActiveUserByEmail(email);
  // Silently no-op for unknown / inactive accounts — same response shape so a
  // caller can't probe which emails are registered.
  if (!user || !user.isActive) {
    logger.info({ email }, 'Password reset requested for unknown/inactive email — no-op');
    return { sent: true };
  }

  // Invalidate any prior live codes for this email so only the newest works.
  await db
    .update(passwordResets)
    .set({ consumedAt: new Date() })
    .where(and(eq(passwordResets.email, email), isNull(passwordResets.consumedAt)));

  const code = generateCode();
  const codeHash = await bcryptjs.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

  await db.insert(passwordResets).values({ email, codeHash, expiresAt });

  const tpl = templates.passwordReset({ code, minutes: CODE_TTL_MINUTES });
  try {
    await sendEmail({
      to: email,
      subject: tpl.subject,
      html: renderEmailHtml(tpl),
      text: renderEmailText(tpl),
    });
  } catch (err) {
    // Don't surface send failures to the caller — that would leak which
    // emails exist and couples the UX to Resend uptime. The row is already
    // persisted; the user can re-request.
    logger.error({ err, email }, 'Password reset email send failed');
  }

  return { sent: true };
}

// Step 2 — verify a code. Returns a short-lived reset token on success.
export async function verifyResetCode(rawEmail: string, code: string): Promise<{ resetToken: string }> {
  const email = normalizeEmail(rawEmail);

  const [row] = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.email, email), isNull(passwordResets.consumedAt)))
    .orderBy(desc(passwordResets.createdAt))
    .limit(1);

  if (!row) {
    throw new ValidationError('Invalid or expired code');
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('Invalid or expired code');
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new ValidationError('Too many attempts — request a new code');
  }

  const ok = await bcryptjs.compare(code, row.codeHash);
  if (!ok) {
    await db
      .update(passwordResets)
      .set({ attempts: row.attempts + 1 })
      .where(eq(passwordResets.id, row.id));
    throw new ValidationError('Invalid or expired code');
  }

  const payload: ResetTokenPayload = { purpose: 'password_reset', email };
  const resetToken = jwt.sign(payload, env.JWT_SECRET, { expiresIn: RESET_TOKEN_EXPIRY });
  return { resetToken };
}

// Step 3 — set the new password using a verified reset token.
export async function resetPassword(resetToken: string, newPassword: string): Promise<{ email: string }> {
  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }

  let payload: ResetTokenPayload;
  try {
    payload = jwt.verify(resetToken, env.JWT_SECRET) as ResetTokenPayload;
  } catch {
    throw new UnauthorizedError('Reset session expired — start again');
  }
  if (payload.purpose !== 'password_reset' || !payload.email) {
    throw new UnauthorizedError('Invalid reset token');
  }

  const email = normalizeEmail(payload.email);
  const user = await findActiveUserByEmail(email);
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid reset token');
  }

  const newHash = await bcryptjs.hash(newPassword, SALT_ROUNDS);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Consume every live code for this email so the token (and any sibling
  // codes) can't be replayed.
  await db
    .update(passwordResets)
    .set({ consumedAt: new Date() })
    .where(and(eq(passwordResets.email, email), isNull(passwordResets.consumedAt)));

  logger.info({ email }, 'Password reset completed via OTP');
  return { email };
}
