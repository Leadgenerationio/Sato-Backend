/**
 * Set a user's password directly, from inside the deployment.
 *
 * Why this exists: onboarding a client whose mail provider filters our invites
 * (Barry @ media-active.org.uk, Microsoft 365, Aug 2026) needs a password set
 * by hand — the ?welcome=1 link is NOT an email-free path, it emails a 6-digit
 * code. The admin UI can do this, but only from a browser session; on Railway
 * the DB is on an internal hostname so it cannot be reached from a laptop.
 * Running here solves both.
 *
 * Usage (inside the container):
 *   npx tsx scripts/reset-user-password.ts <email> <password>
 *
 * Locally:
 *   npx tsx scripts/reset-user-password.ts someone@example.com 'NewPass123'
 *
 * Applies the same rules as the admin endpoint: normalises the password
 * (see utils/password.ts — trimming mismatch caused a permanent lockout),
 * enforces the 8-character minimum, and matches the email case-insensitively.
 * Never prints the password or the hash.
 */

import 'dotenv/config';
import bcryptjs from 'bcryptjs';
import postgres from 'postgres';
import { normalizePassword } from '../src/utils/password.js';

async function run(): Promise<void> {
  const [emailArg, passwordArg] = process.argv.slice(2);

  if (!emailArg || !passwordArg) {
    console.error('Usage: tsx scripts/reset-user-password.ts <email> <password>');
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const password = normalizePassword(passwordArg);

  if (password.length < 8) {
    console.error('[reset] Password must be at least 8 characters after trimming — refusing.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[reset] DATABASE_URL not set');
    process.exit(1);
  }

  const sql = postgres(url);
  try {
    const found = await sql.unsafe(
      `select u.id, u.email, u.name, u.role, u.is_active, u.client_id, c.company_name
         from users u
         left join clients c on c.id = u.client_id
        where lower(u.email) = $1`,
      [email],
    );

    if (found.length === 0) {
      console.error(`[reset] No user found with email ${email} — nothing changed.`);
      console.error('[reset] Create the portal user first, then re-run this.');
      process.exit(2);
    }

    const user = found[0] as Record<string, unknown>;
    const hash = await bcryptjs.hash(password, 12);

    await sql.unsafe(
      `update users set password_hash = $1, updated_at = now() where id = $2`,
      [hash, user.id as string],
    );

    console.log('[reset] Password updated.');
    console.log(
      JSON.stringify(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isActive: user.is_active,
          client: user.company_name ?? null,
        },
        null,
        2,
      ),
    );

    if (user.is_active === false) {
      console.warn('[reset] WARNING: this account is INACTIVE — login will report "Account is disabled".');
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[reset] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
