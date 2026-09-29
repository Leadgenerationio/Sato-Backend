/**
 * Report likely test / demo data and untidy contact names.
 *
 * Why this exists: Sam's feedback round 1 (29 Sep 2026) found test data in the
 * live system (N6: SOS "testing"/"msg", SOP "onbording", staff "John") and a
 * security tidy-up (S8: three Owners incl. "Demo" demo@stato.app; test logins
 * test@test.com and john@test.com active).
 *
 * The rules live in src/services/data-cleanup.service.ts, which also powers
 * Settings → Clean up in the portal — the Owner resolves these there with one
 * click (deactivate / change role / archive / trim). This script prints the
 * same report for a terminal and NEVER deletes anything.
 *
 * Usage (inside the container, or locally against a local DB):
 *   npx tsx scripts/audit-test-data.ts                # read-only report (default)
 *   npx tsx scripts/audit-test-data.ts --apply-trim   # ALSO trims leading/trailing
 *                                                     # spaces in contact names/emails (N7)
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/config/database.js';
import { getCleanupReport } from '../src/services/data-cleanup.service.js';
import type { AuthPayload } from '../src/types/index.js';

const APPLY_TRIM = process.argv.includes('--apply-trim');

function section(title: string, rows: object[]): void {
  console.log(`\n== ${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log('   none');
    return;
  }
  for (const r of rows) console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  console.log(`audit-test-data — ${APPLY_TRIM ? 'READ + TRIM WHITESPACE' : 'READ-ONLY'} — ${new Date().toISOString()}`);

  // Unscoped report (no business, no caller) — the whole database.
  const requester: AuthPayload = { userId: '00000000-0000-0000-0000-000000000000', email: 'audit-script', role: 'owner' };
  const r = await getCleanupReport(requester);

  section('Owner accounts (S8: review who should be Owner)', r.owners.map(({ email, name, isPrimaryOwner }) => ({ email, name, isPrimaryOwner })));
  section('Test / demo logins (S8)', r.testLogins.map(({ email, name, role, reason }) => ({ email, name, role, reason })));
  section('SOS queue: test messages (N6)', r.testSos.map(({ id, label, reason }) => ({ id, message: label, reason })));
  section('SOPs: test / misspelt titles (N6)', r.testSops.map(({ id, label, reason }) => ({ id, title: label, reason })));
  section('Staff: placeholder records (N6)', r.placeholderStaff.map(({ id, label, detail, reason }) => ({ id, name: label, email: detail, reason })));
  console.log(`\n== Active agreement templates: ${r.agreementTemplatesCount}${r.agreementTemplatesCount === 0 ? '  (N6: none — Send Agreement will have nothing to pick)' : ''}`);
  section('Contacts / clients with leading/trailing spaces (N7)', r.untrimmedContacts.map(({ id, kind, label }) => ({ id, kind, value: label })));

  if (APPLY_TRIM && r.untrimmedContacts.length > 0) {
    const a = await db.execute(sql`
      UPDATE client_contacts SET name = trim(name), email = trim(email), updated_at = now()
      WHERE name <> trim(name) OR email <> trim(email)`);
    const b = await db.execute(sql`
      UPDATE clients SET contact_name = trim(contact_name), contact_email = trim(contact_email),
                         company_name = trim(company_name), updated_at = now()
      WHERE contact_name <> trim(contact_name) OR contact_email <> trim(contact_email) OR company_name <> trim(company_name)`);
    console.log(`\n   trimmed: ${(a as unknown as { count: number }).count} contact row(s), ${(b as unknown as { count: number }).count} client row(s)`);
  } else if (r.untrimmedContacts.length > 0) {
    console.log('\n   (re-run with --apply-trim to fix these — whitespace only)');
  }

  console.log('\nResolve the rest in the portal: Settings → User Management → Clean up (Owner only).');
  process.exit(0);
}

main().catch((err) => {
  console.error('audit-test-data failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
