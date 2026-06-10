import { describe, it, expect, beforeAll, vi } from 'vitest';
import bcryptjs from 'bcryptjs';
import { eq, and, desc, isNull } from 'drizzle-orm';

// Intercept the Resend send so we can read the 6-digit code straight out of
// the email body — the same way a real user reads it from their inbox. Far
// cheaper than brute-forcing the bcrypt-hashed code stored in the DB.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(async () => ({ id: 'mock-test' })) }));
vi.mock('../integrations/resend/resend-client.js', () => ({
  isResendConfigured: () => false,
  sendEmail: sendEmailMock,
}));

// Every step does bcrypt (cost 12); several tests chain 5-7 sequential ops.
// Under concurrent load in the full suite the default 5s timeout is borderline,
// so give this file generous headroom.
vi.setConfig({ testTimeout: 30000 });

import {
  requestPasswordReset, verifyResetCode, resetPassword,
} from '../services/password-reset.service.js';
import { createUser } from '../services/user.service.js';
import { findUserById, SEED_USER_IDS } from '../data/users.js';
import { db } from '../config/database.js';
import { passwordResets } from '../db/schema/index.js';
import type { AuthPayload } from '../types/index.js';

const ownerPayload: AuthPayload = {
  userId: SEED_USER_IDS.OWNER,
  email: 'owner@stato.app',
  role: 'owner',
};

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

// Read the code out of the most recent captured email for `email`.
function latestCodeFor(email: string): string {
  const calls = sendEmailMock.mock.calls.filter((c) => {
    const to = (c[0] as { to: string | string[] }).to;
    return (Array.isArray(to) ? to : [to]).includes(email.toLowerCase());
  });
  if (calls.length === 0) throw new Error(`no email captured for ${email}`);
  const req = calls[calls.length - 1][0] as { html: string; text: string };
  const match = (req.text || req.html).match(/(?<!\d)(\d{6})(?!\d)/);
  if (!match) throw new Error('no 6-digit code in email body');
  return match[1];
}

describe('Password Reset (forgot-password OTP)', () => {
  let userId: string;
  let email: string;

  beforeAll(async () => {
    email = uniqueEmail('reset-otp');
    const u = await createUser(email, 'Reset OTP', 'original-pw-123', 'readonly', ownerPayload);
    userId = u.id;
  });

  describe('requestPasswordReset', () => {
    it('creates a live code row for a known email', async () => {
      const res = await requestPasswordReset(email);
      expect(res.sent).toBe(true);
      const code = await latestCodeFor(email);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('returns success for an unknown email without creating a row (no enumeration)', async () => {
      const ghost = uniqueEmail('ghost');
      const res = await requestPasswordReset(ghost);
      expect(res.sent).toBe(true);
      const rows = await db.select().from(passwordResets).where(eq(passwordResets.email, ghost.toLowerCase()));
      expect(rows.length).toBe(0);
    });

    it('invalidates a prior code when a new one is requested', async () => {
      await requestPasswordReset(email);
      const firstCode = await latestCodeFor(email);
      await requestPasswordReset(email); // supersedes the first
      // The first code should no longer verify.
      await expect(verifyResetCode(email, firstCode)).rejects.toThrow(/Invalid or expired/);
    });
  });

  describe('verifyResetCode', () => {
    it('returns a reset token for a correct code', async () => {
      await requestPasswordReset(email);
      const code = await latestCodeFor(email);
      const { resetToken } = await verifyResetCode(email, code);
      expect(typeof resetToken).toBe('string');
      expect(resetToken.length).toBeGreaterThan(20);
    });

    it('rejects a wrong code and increments attempts', async () => {
      await requestPasswordReset(email);
      await expect(verifyResetCode(email, '000000')).rejects.toThrow(/Invalid or expired/);
      const [row] = await db
        .select()
        .from(passwordResets)
        .where(and(eq(passwordResets.email, email.toLowerCase()), isNull(passwordResets.consumedAt)))
        .orderBy(desc(passwordResets.createdAt))
        .limit(1);
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    });

    it('locks out after 5 failed attempts', async () => {
      await requestPasswordReset(email);
      for (let i = 0; i < 5; i++) {
        await expect(verifyResetCode(email, '000000')).rejects.toThrow(/Invalid or expired/);
      }
      // 6th attempt — even the right code is refused once locked.
      const code = await latestCodeFor(email);
      await expect(verifyResetCode(email, code)).rejects.toThrow(/Too many attempts/);
    });

    it('rejects when no code was ever requested', async () => {
      await expect(verifyResetCode(uniqueEmail('never'), '123456')).rejects.toThrow(/Invalid or expired/);
    });
  });

  describe('resetPassword', () => {
    it('sets a new password end-to-end and the old one stops working', async () => {
      await requestPasswordReset(email);
      const code = await latestCodeFor(email);
      const { resetToken } = await verifyResetCode(email, code);
      await resetPassword(resetToken, 'brand-new-pw-999');

      const user = (await findUserById(userId))!;
      expect(await bcryptjs.compare('brand-new-pw-999', user.passwordHash)).toBe(true);
      expect(await bcryptjs.compare('original-pw-123', user.passwordHash)).toBe(false);
    });

    it('rejects a too-short new password', async () => {
      await requestPasswordReset(email);
      const code = await latestCodeFor(email);
      const { resetToken } = await verifyResetCode(email, code);
      await expect(resetPassword(resetToken, 'short')).rejects.toThrow(/at least 8 characters/);
    });

    it('rejects a garbage reset token', async () => {
      await expect(resetPassword('not-a-real-token', 'brand-new-pw-999')).rejects.toThrow(/Reset session expired|Invalid reset token/);
    });

    it('consumes the code so the token cannot be replayed', async () => {
      await requestPasswordReset(email);
      const code = await latestCodeFor(email);
      const { resetToken } = await verifyResetCode(email, code);
      await resetPassword(resetToken, 'replay-test-pw-1');
      // Same token again — code is consumed, so re-verifying the code fails.
      await expect(verifyResetCode(email, code)).rejects.toThrow(/Invalid or expired/);
    });
  });
});
