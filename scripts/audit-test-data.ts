/**
 * Report likely test / demo data and untidy contact names.
 *
 * Why this exists: Sam's feedback round 1 (29 Sep 2026) found test data in the
 * live system (N6: SOS "testing"/"msg", SOP "onbording", staff "John") and a
 * security tidy-up (S8: three Owners incl. "Demo" demo@stato.app; test logins
 * test@test.com and john@test.com active). Deleting people's accounts is a
 * human decision, so this script NEVER deletes anything.
 *
 * Usage (inside the container, or locally against a local DB):
 *   npx tsx scripts/audit-test-data.ts                # read-only report (default)
 *   npx tsx scripts/audit-test-data.ts --apply-trim   # ALSO trims leading/trailing
 *                                                     # spaces in contact names/emails (N7)
 *
 * Output:
 *   1. What was found, per category.
 *   2. Suggested SQL for removals/deactivations, COMMENTED OUT, for a person
 *      to review and run deliberately. Deactivating a user (is_active=false)
 *      is suggested over deleting, because audit rows reference users.
 *
 * Only `--apply-trim` writes, and only whitespace: it can't lose information.
 */

import 'dotenv/config';
import postgres from 'postgres';

const APPLY_TRIM = process.argv.includes('--apply-trim');

// Emails/names that look like fixtures. Matched case-insensitively.
const TEST_EMAIL_PATTERNS = ['%@test.com', '%@example.com', 'demo@%', 'test@%', '%+test@%'];
const TEST_TEXT = ['test', 'testing', 'msg', 'asdf', 'demo', 'do not save', 'ux test'];

type Row = Record<string, unknown>;

function section(title: string, rows: Row[]): void {
  console.log(`\n== ${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log('   none');
    return;
  }
  for (const r of rows) console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const suggestions: string[] = [];

  try {
    console.log(`audit-test-data — ${APPLY_TRIM ? 'READ + TRIM WHITESPACE' : 'READ-ONLY'} — ${new Date().toISOString()}`);

    // S8: owners. More than one owner is worth a human look.
    const owners = await sql<Row[]>`
      SELECT email, name, is_active, is_primary_owner, created_at::date AS created
      FROM users WHERE role = 'owner' ORDER BY created_at`;
    section('Owner accounts (S8: review who should be Owner)', owners);

    // S8: test-looking logins, any role.
    const testUsers = await sql<Row[]>`
      SELECT email, name, role, is_active, created_at::date AS created
      FROM users
      WHERE email ILIKE ANY(${sql.array(TEST_EMAIL_PATTERNS)})
         OR lower(trim(name)) IN ${sql(['demo', 'test', 'john', 'test user'])}
      ORDER BY created_at`;
    section('Test / demo logins (S8)', testUsers);
    for (const u of testUsers) {
      if (u.is_active) suggestions.push(`-- UPDATE users SET is_active = false, updated_at = now() WHERE lower(email) = lower('${String(u.email).replace(/'/g, "''")}');`);
    }

    // N6: SOS entries with throwaway messages.
    const sos = await sql<Row[]>`
      SELECT id, left(message, 60) AS message, created_at::date AS created, resolved_at IS NOT NULL AS resolved
      FROM sos_help_requests
      WHERE lower(trim(message)) IN ${sql(TEST_TEXT)} OR length(trim(message)) <= 3
      ORDER BY created_at`;
    section('SOS queue: test messages (N6)', sos);
    for (const s of sos) suggestions.push(`-- DELETE FROM sos_help_requests WHERE id = '${s.id}';`);

    // N6: SOPs with test / misspelt titles.
    const sops = await sql<Row[]>`
      SELECT id, title, status, created_at::date AS created
      FROM sops
      WHERE lower(trim(title)) IN ${sql([...TEST_TEXT, 'onbording'])} OR length(trim(title)) <= 3
      ORDER BY created_at`;
    section('SOPs: test / misspelt titles (N6)', sops);
    for (const s of sops) suggestions.push(`-- review, then: DELETE FROM sops WHERE id = '${s.id}';  -- or fix the title`);

    // N6: staff records that look like placeholders (single first name only).
    const staff = await sql<Row[]>`
      SELECT id, name, email, role, status
      FROM staff
      WHERE lower(trim(name)) IN ${sql(['john', 'test', 'demo'])}
         OR position(' ' in trim(name)) = 0
      ORDER BY created_at`;
    section('Staff: placeholder records (N6)', staff);
    for (const s of staff) suggestions.push(`-- review, then: DELETE FROM staff WHERE id = '${s.id}';`);

    // Clients whose name says test.
    const testClients = await sql<Row[]>`
      SELECT id, company_name, status, created_at::date AS created
      FROM clients
      WHERE company_name ILIKE '%test%' OR company_name ILIKE '%do not%' OR company_name ILIKE '%(for demo)%'
      ORDER BY created_at`;
    section('Clients named like test/demo (review only — clients own invoices)', testClients);

    // N6: agreement templates (Sam: "no agreement templates").
    const [{ n: templates }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agreement_templates WHERE archived_at IS NULL`;
    console.log(`\n== Active agreement templates: ${templates}${templates === 0 ? '  (N6: none — Send Agreement will have nothing to pick)' : ''}`);

    // N7: untrimmed contact names/emails.
    const untrimmedContacts = await sql<Row[]>`
      SELECT id, name, email FROM client_contacts
      WHERE name <> trim(name) OR email <> trim(email)`;
    const untrimmedClients = await sql<Row[]>`
      SELECT id, company_name, contact_name, contact_email FROM clients
      WHERE contact_name <> trim(contact_name) OR contact_email <> trim(contact_email) OR company_name <> trim(company_name)`;
    section('Contacts with leading/trailing spaces (N7)', untrimmedContacts);
    section('Clients with leading/trailing spaces (N7)', untrimmedClients);

    if (APPLY_TRIM && (untrimmedContacts.length > 0 || untrimmedClients.length > 0)) {
      const a = await sql`
        UPDATE client_contacts SET name = trim(name), email = trim(email), updated_at = now()
        WHERE name <> trim(name) OR email <> trim(email)`;
      const b = await sql`
        UPDATE clients SET contact_name = trim(contact_name), contact_email = trim(contact_email),
                           company_name = trim(company_name), updated_at = now()
        WHERE contact_name <> trim(contact_name) OR contact_email <> trim(contact_email) OR company_name <> trim(company_name)`;
      console.log(`\n   trimmed: ${a.count} contact row(s), ${b.count} client row(s)`);
    } else if (untrimmedContacts.length + untrimmedClients.length > 0) {
      console.log('\n   (re-run with --apply-trim to fix these — whitespace only)');
    }

    console.log('\n== Suggested SQL — REVIEW BEFORE RUNNING, nothing below was executed');
    if (suggestions.length === 0) console.log('   none');
    else for (const s of suggestions) console.log('   ' + s);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('audit-test-data failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
