/**
 * Production-safe automatic seeder.
 *
 * Runs on container start (after auto-migrate, before the server boots).
 *
 * Behaviour:
 *  - If the `users` table has any rows: no-op (subsequent deploys don't disturb
 *    real users).
 *  - If empty: insert the internal users (owner / finance / ops / readonly) using
 *    passwords from SEED_*_PASSWORD env vars. In production only accounts whose
 *    password is set are created (never a default one).
 *  - In production, REFUSES to seed if SEED_OWNER_PASSWORD is unset — would
 *    otherwise create a well-known-password owner account, which is a
 *    credential leak. The container exits non-zero so Railway surfaces the
 *    misconfiguration before the server starts.
 *
 * Idempotent — safe to run on every container start. Never logs passwords.
 */

import 'dotenv/config';
import postgres from 'postgres';
import bcryptjs from 'bcryptjs';
import { buildSeedUsers, SeedConfigError, type SeedUser } from '../src/utils/seed-users.js';

const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[seed-if-empty] DATABASE_URL not set — skipping');
    return;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM users
    `;

    if (count > 0) {
      console.log(`[seed-if-empty] users table has ${count} row(s) — skipping seed`);
      return;
    }

    console.log('[seed-if-empty] users table empty — seeding internal users');

    // In production, NEVER fall back to dev defaults. The owner's password is mandatory (fail
    // loudly so the operator notices); the other three accounts are only created when their
    // own password env var is set (see src/utils/seed-users.ts).
    let seed: SeedUser[];
    try {
      const built = buildSeedUsers(process.env, isProd);
      seed = built.users;
      for (const s of built.skipped) console.log(`[seed-if-empty] not creating ${s}`);
    } catch (err) {
      if (err instanceof SeedConfigError) {
        console.error(`[seed-if-empty] FATAL: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    // Make sure the leadgeneration.io business row exists (FK target).
    await sql`
      INSERT INTO businesses (id, name, slug, colour, status)
      VALUES (${LEADGEN_BUSINESS_ID}, 'leadgeneration.io', 'leadgeneration', '#171717', 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    for (const u of seed) {
      const hash = await bcryptjs.hash(u.password, 12);
      await sql`
        INSERT INTO users (email, password_hash, name, role, business_id, is_active, is_primary_owner)
        VALUES (${u.email}, ${hash}, ${u.name}, ${u.role}, ${LEADGEN_BUSINESS_ID}, true, ${u.isPrimaryOwner})
        ON CONFLICT (email) DO NOTHING
      `;
    }

    console.log(`[seed-if-empty] seeded ${seed.length} internal users (passwords NOT logged)`);
  } catch (err) {
    console.error('[seed-if-empty] failed:', err instanceof Error ? err.message : err);
    // Don't crash the container on seed failure — migration succeeded, server
    // should still come up. An admin can run db:seed manually if needed.
    // (Exception: prod-without-SEED_OWNER_PASSWORD already exited above.)
  } finally {
    await sql.end({ timeout: 5 });
  }
}

run().catch((err) => {
  console.error('[seed-if-empty] fatal:', err);
  process.exit(1);
});
