import 'dotenv/config';
import { db } from '../src/config/database.js';
import { workflows } from '../src/db/schema/workflows.js';
import { invoices } from '../src/db/schema/invoices.js';
import { clients } from '../src/db/schema/clients.js';
import { autoInvoiceRuns } from '../src/db/schema/auto-invoice-runs.js';
import { and, eq, sql, inArray } from 'drizzle-orm';

/**
 * One-shot ops script for the 2026-05-21 incident:
 *
 *   - Two auto-invoice draft rows (£17,880 + £21,465) leaked into the
 *     portal's "Outstanding £44,000" total for UK Energy Saving Network.
 *     They were never pushed to Xero (xero_invoice_id IS NULL) yet had
 *     status='sent' or similar, so the old outstanding filter caught
 *     them. T5 closed the structural hole by also requiring a non-null
 *     xero_invoice_id, but the existing bad rows still exist in the
 *     table — they need to be retired explicitly.
 *
 *   - Sam wants auto-invoice paused entirely until it's hardened. The
 *     worker honours workflows.status='paused' on the row whose
 *     handler_key='auto-invoice' (see worker-entry.ts → isAutomationPaused).
 *
 * Run on prod with:
 *
 *   pnpm tsx scripts/pause-auto-invoice-and-quarantine-drafts.ts          # dry-run (default)
 *   pnpm tsx scripts/pause-auto-invoice-and-quarantine-drafts.ts --apply  # commit
 *
 * Dry-run prints exactly what would change without touching the DB.
 * --apply wraps the UPDATEs in a transaction so a mid-run failure
 * leaves prod consistent.
 *
 * Safety gate: --apply refuses to run if the candidate-draft count
 * isn't exactly 2 (the incident shape Sam described). Pass
 * --allow-different-count to override; intended for a partial-cleanup
 * recovery where one row has already been voided by hand.
 *
 * Idempotent on retry: re-running after --apply is a no-op
 *   - workflow already paused → UPDATE matches 0 rows
 *   - invoices already voided → SELECT for drafts returns []
 *
 * Per the task spec: VOID, do NOT hard-delete. Voiding preserves the
 * audit trail and matches Stato's existing PORTAL_INVOICE_HIDDEN_STATUSES
 * convention so the portal stops showing them.
 */

const APPLY = process.argv.includes('--apply');
// Safety gate: --apply refuses to run if the candidate-draft count
// isn't exactly EXPECTED_DRAFT_COUNT. Pass --allow-different-count to
// override (e.g. one row was already voided by hand). Prevents an
// unrelated row that happens to match the totals from being voided.
const ALLOW_DIFFERENT_COUNT = process.argv.includes('--allow-different-count');
const CLIENT_NAME = 'UK Energy Saving Network';

// Exact totals Sam pointed at. Treated as ±£0.01 because decimal(12,2)
// columns can have trailing zeroes that ===-match the integer literal
// but it's safer to compare numerically.
const DRAFT_TOTALS = [17880, 21465];
const EXPECTED_DRAFT_COUNT = 2;

function tag(): string {
  return APPLY ? '[APPLY]' : '[DRY-RUN]';
}

async function main() {
  console.log(`${tag()} pause-auto-invoice + quarantine drafts — start`);
  console.log('');

  // ─── Step 1: locate the client row ─────────────────────────────
  const clientRows = await db
    .select()
    .from(clients)
    .where(eq(clients.companyName, CLIENT_NAME));

  if (clientRows.length === 0) {
    console.error(`✗ no client found with company_name=${JSON.stringify(CLIENT_NAME)}`);
    console.error('  Cannot proceed — the quarantine step needs the client_id to scope its UPDATE.');
    process.exit(1);
  }
  if (clientRows.length > 1) {
    console.error(`✗ ${clientRows.length} clients matched company_name=${JSON.stringify(CLIENT_NAME)}`);
    console.error('  Tighten the lookup before re-running (e.g. by business_id).');
    process.exit(1);
  }
  const client = clientRows[0]!;
  console.log(`✓ client: ${client.companyName}  id=${client.id}  business=${client.businessId}`);
  console.log('');

  // ─── Step 2: outstanding total BEFORE ──────────────────────────
  const before = await outstandingTotal(client.id);
  console.log(`outstanding BEFORE: £${before.total.toFixed(2)}  (${before.count} rows)`);
  before.rows.forEach((r) => console.log(`  · ${r.invoiceNumber.padEnd(14)} ${r.status.padEnd(12)} £${r.total.toFixed(2).padStart(10)}  xero=${r.xeroInvoiceId ?? 'NULL'}`));
  console.log('');

  // ─── Step 3: locate the two leaked drafts ──────────────────────
  // The spec describes them as "draft invoices", but the T5 commit on
  // 2026-05-20 notes the leak rows had status='sent' with a null
  // xero_invoice_id (the auto-invoice handler flips status BEFORE the
  // Xero push, so a failed push leaves an orphan in either shape).
  // Match BOTH so we don't miss the row depending on where the push
  // failed. Exclude paid/voided/deleted so re-runs of this script are
  // safe — already-voided rows are skipped.
  const drafts = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.clientId, client.id),
        inArray(invoices.status, ['draft', 'sent']),
        sql`${invoices.xeroInvoiceId} IS NULL`,
        inArray(
          sql<number>`CAST(${invoices.total} AS NUMERIC)`,
          DRAFT_TOTALS,
        ),
      ),
    );

  console.log(`candidate drafts to void: ${drafts.length} (expected 2)`);
  for (const d of drafts) {
    const runRef = await findAutoInvoiceRunRef(d.id);
    console.log(`  · ${(d.invoiceNumber ?? '<no number>').padEnd(14)} total=£${Number(d.total ?? 0).toFixed(2).padStart(10)}  created=${d.createdAt?.toISOString() ?? '?'}  run=${runRef ?? '<not found in auto_invoice_runs.details>'}`);
  }
  console.log('');

  if (drafts.length === 0) {
    console.log('→ no drafts match the criteria; quarantine step is a no-op (already cleaned up?)');
  } else if (drafts.length !== EXPECTED_DRAFT_COUNT) {
    console.warn(`⚠ expected exactly ${EXPECTED_DRAFT_COUNT} drafts but found ${drafts.length} — DOUBLE-CHECK before --apply`);
  }

  // ─── Step 4: locate the auto-invoice workflow row(s) ──────────
  const wfRows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.handlerKey, 'auto-invoice'));

  console.log(`auto-invoice workflow rows: ${wfRows.length}`);
  wfRows.forEach((w) => console.log(`  · ${w.id}  business=${w.businessId}  status=${w.status}  name=${w.name}`));
  if (wfRows.length === 0) {
    console.warn('⚠ no workflow row with handler_key=auto-invoice — PR #7 (seed migration) likely not yet merged');
    console.warn('  The cron will keep firing until that row exists for the worker to read. Pause is then a no-op.');
  }
  console.log('');

  // ─── Step 5: execute, if --apply ───────────────────────────────
  if (!APPLY) {
    console.log(`${tag()} done — no changes written. Re-run with --apply to commit.`);
    process.exit(0);
  }

  // Safety gate. Refuse to void if the candidate count doesn't match
  // the spec's expectation, unless the operator has explicitly opted in.
  // Wrong count = something unexpected on prod; stop and let a human
  // eyeball the dry-run output before touching rows.
  //
  // We split 0 candidates from N≠2 because the most likely cause of 0
  // is a successful re-run, and "review the candidate list above"
  // doesn't help when the list is empty.
  if (drafts.length !== EXPECTED_DRAFT_COUNT && !ALLOW_DIFFERENT_COUNT) {
    console.error('');
    if (drafts.length === 0) {
      console.error('✗ aborting: 0 draft candidates matched the spec totals.');
      console.error('  Most likely cause: --apply has already run successfully and the rows are');
      console.error('  voided. The workflow-pause step is still effective on its own — if you');
      console.error('  intended to re-pause the cron without touching invoices, run');
      console.error('  --apply --allow-different-count to skip this guard.');
    } else {
      console.error(`✗ aborting: expected exactly ${EXPECTED_DRAFT_COUNT} draft candidate(s) but found ${drafts.length}.`);
      console.error('  This is either a different incident than the one Sam reported, or one of');
      console.error('  the rows was already retired by hand. Review the candidate list above.');
      console.error('  To proceed anyway, re-run with --apply --allow-different-count');
    }
    process.exit(2);
  }

  console.log(`${tag()} executing destructive operations inside a transaction…`);
  await db.transaction(async (tx) => {
    if (wfRows.length > 0) {
      const updated = await tx
        .update(workflows)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(workflows.handlerKey, 'auto-invoice'), sql`${workflows.status} <> 'paused'`))
        .returning({ id: workflows.id });
      console.log(`  ✓ paused ${updated.length} workflow row(s)`);
    }

    if (drafts.length > 0) {
      const voided = await tx
        .update(invoices)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(inArray(invoices.id, drafts.map((d) => d.id)))
        .returning({ id: invoices.id, invoiceNumber: invoices.invoiceNumber });
      console.log(`  ✓ voided ${voided.length} draft invoice(s):`);
      voided.forEach((v) => console.log(`      · ${v.invoiceNumber ?? '<no number>'}  id=${v.id}`));
    }
  });
  console.log('');

  // ─── Step 6: outstanding total AFTER ───────────────────────────
  const after = await outstandingTotal(client.id);
  console.log(`outstanding AFTER:  £${after.total.toFixed(2)}  (${after.count} rows)`);
  after.rows.forEach((r) => console.log(`  · ${r.invoiceNumber.padEnd(14)} ${r.status.padEnd(12)} £${r.total.toFixed(2).padStart(10)}  xero=${r.xeroInvoiceId ?? 'NULL'}`));
  console.log('');
  console.log(`Δ: £${(before.total - after.total).toFixed(2)} removed`);
  console.log(`${tag()} done.`);
}

/**
 * Mirror of the portal's "outstanding" rule (see portal.service.ts
 * + invoice.service.isOutstandingInvoice): status in (sent, authorised,
 * overdue) AND xero_invoice_id IS NOT NULL. Listed separately here so
 * we can show what the portal SEES, not just every-row-not-paid.
 */
async function outstandingTotal(clientId: string) {
  const rows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.clientId, clientId),
        inArray(invoices.status, ['sent', 'authorised', 'overdue']),
        sql`${invoices.xeroInvoiceId} IS NOT NULL`,
      ),
    );
  const total = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
  return {
    count: rows.length,
    total,
    rows: rows.map((r) => ({
      invoiceNumber: r.invoiceNumber ?? '<no number>',
      status: r.status ?? '<null>',
      total: Number(r.total ?? 0),
      xeroInvoiceId: r.xeroInvoiceId,
    })),
  };
}

/**
 * Best-effort provenance lookup. The invoices table has no direct FK
 * to auto_invoice_runs — the link lives in auto_invoice_runs.details
 * (jsonb array of { invoiceId, ... }). Use jsonb_path_exists for an
 * indexable-ish scan; returns the run UUID + period if matched.
 */
async function findAutoInvoiceRunRef(invoiceId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: autoInvoiceRuns.id,
      periodFrom: autoInvoiceRuns.periodFrom,
      periodTo: autoInvoiceRuns.periodTo,
    })
    .from(autoInvoiceRuns)
    .where(sql`${autoInvoiceRuns.details} @> ${JSON.stringify([{ invoiceId }])}::jsonb`);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return `${r.id}  (${r.periodFrom} → ${r.periodTo})`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
  });
