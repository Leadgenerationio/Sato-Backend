/**
 * Creates the unique index "one live creative per (client, file hash)". NOT part of auto-migrate: CREATE INDEX CONCURRENTLY
 * cannot run in a transaction.
 *   npx tsx scripts/create-creative-unique-index.ts --host=<the DATABASE_URL host> [--dry-run]
 * It refuses while duplicates exist, leaves a valid index alone, rebuilds an INVALID one, and checks the result.
 * --host must name the host DATABASE_URL really points at, so a wrong database cannot be hit by accident.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { ensureUniqueIndex } from './lib/creative-unique-index.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const host = new URL(url).hostname;
const given = process.argv.find((a) => a.startsWith('--host='))?.slice('--host='.length);
if (given !== host) { console.error(`Refusing to run: pass --host=<the database host>. This DATABASE_URL points at "${host}".`); process.exit(2); }
const sql = postgres(url, { max: 1 });
try {
  const r = await ensureUniqueIndex(sql, { dryRun: process.argv.includes('--dry-run'), log: (m) => console.log(m) });
  console.log(`result: ${r.result}`);
  await sql.end();
  process.exit(r.result === 'refused_duplicates' || r.result === 'failed' ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await sql.end().catch(() => {});
  process.exit(2);
}
