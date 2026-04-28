/**
 * Defensive startup migrator.
 *
 * Runs every SQL file in src/db/migrations/ in order, splitting on Drizzle's
 * `--> statement-breakpoint` markers and executing each statement. Errors that
 * mean "this thing already exists" are tolerated (so re-running is safe even
 * when migrations 0000-0003 don't carry IF NOT EXISTS guards). Anything else
 * fails fast — the container dies and Railway will restart, surfacing the
 * problem immediately.
 *
 * This is intentionally simpler than drizzle-kit's journal-based migrator
 * because:
 *   1. We don't know whether prod was originally bootstrapped via `db:push`
 *      (no journal) or `db:migrate` (with journal). This works either way.
 *   2. Our newer migrations already use IF NOT EXISTS, so the only risk is
 *      the first three migrations — and those would only re-run if the
 *      journal is missing, in which case the tables they create already
 *      exist.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const ALREADY_EXISTS_PATTERNS = [
  /already exists/i,                    // generic "X already exists"
  /duplicate.*type/i,                   // CREATE TYPE on existing enum
  /relation .* already exists/i,        // CREATE TABLE / INDEX on existing
  /constraint .* already exists/i,      // ADD CONSTRAINT on existing
  /index .* already exists/i,
  /column .* of relation .* already exists/i, // ALTER TABLE ADD COLUMN
  /multiple primary keys.*are not allowed/i,  // re-running CREATE TABLE in some dialects
];

function isAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return ALREADY_EXISTS_PATTERNS.some((rx) => rx.test(msg));
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[auto-migrate] DATABASE_URL not set — skipping migrations');
    return;
  }

  const migrationsDir = path.resolve('src/db/migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[auto-migrate] migrations dir not found at ${migrationsDir} — skipping`);
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[auto-migrate] no migration files found, nothing to do');
    return;
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let totalApplied = 0;
  let totalSkipped = 0;

  try {
    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      // Drizzle uses --> statement-breakpoint as separator; non-drizzle SQL
      // files (like our hand-written 0007) just have semicolons. Split on
      // the breakpoint when present, otherwise treat the whole file as one.
      const statements = content.includes('statement-breakpoint')
        ? content.split(/-->\s*statement-breakpoint\s*/i)
        : [content];

      for (const raw of statements) {
        const stmt = raw.trim();
        if (!stmt) continue;
        // Skip statements that are *only* SQL comments (-- ... lines and blank lines).
        // Don't use a startsWith check — that would skip files where SQL follows
        // a comment header.
        const nonCommentBody = stmt
          .split('\n')
          .filter((line) => line.trim() && !line.trim().startsWith('--'))
          .join('\n')
          .trim();
        if (!nonCommentBody) continue;
        try {
          await sql.unsafe(stmt);
          totalApplied++;
        } catch (err) {
          if (isAlreadyExistsError(err)) {
            totalSkipped++;
          } else {
            console.error(`[auto-migrate] FAILED in ${file}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
        }
      }
    }
    console.log(`[auto-migrate] done — ${totalApplied} statements applied, ${totalSkipped} skipped (already existed)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

run().catch((err) => {
  console.error('[auto-migrate] fatal:', err);
  process.exit(1);
});
