/**
 * @runs-in-image (run inside the production container: only files the Dockerfile copies may be imported; see src/__tests__/scripts-in-image.test.ts)
 * Read-only: lists live creatives that share (client, file hash). Run it before creating the unique index.
 *   npx tsx scripts/check-creative-duplicates.ts [--json]
 * Exit code 0 = none, 1 = duplicates found.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { findDuplicateGroups } from './lib/creative-unique-index.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(url, { max: 1 });
try {
  const groups = await findDuplicateGroups(sql);
  if (process.argv.includes('--json')) console.log(JSON.stringify(groups, null, 2));
  else if (groups.length === 0) console.log('No duplicates: the unique index can be created.');
  else {
    console.log(`${groups.length} group(s) of duplicates (${groups.reduce((n, g) => n + g.count - 1, 0)} extra creatives):`);
    for (const g of groups) console.log(`  client ${g.clientId}  sha256 ${g.sha256.slice(0, 12)}…  ${g.count} creatives: ${g.ids.join(', ')}  (the oldest is ${g.ids[0]})`);
    console.log('Archive or delete the extras in the portal (keep the oldest), then run this again.');
  }
  await sql.end();
  process.exit(groups.length ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await sql.end().catch(() => {});
  process.exit(2);
}
