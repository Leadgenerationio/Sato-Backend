-- T4 follow-up (Sam, 2026-05-21): seed the three workflow rows that bind
-- to real BullMQ handlers via the handler_key column.
--
-- Symptom this fixes: pause/resume button never renders. The Finance →
-- Auto Invoice page locates its workflow via `find(w => w.handlerKey ===
-- 'auto-invoice')`; the generic /workflows admin page renders one row per
-- workflow. With no workflows.handler_key rows in the table the find()
-- returns undefined, both UIs hide everything, and there is no way for
-- Sam to pause auto-invoice without SQL on prod — the exact problem T4
-- was meant to solve.
--
-- The handler functions live at src/jobs/workflow-handlers.ts:
--   - chase-overdue       — daily email chase for overdue invoices
--   - auto-invoice        — Mondays 09:00 UTC, drafts weekly Xero invoices
--   - monthly-validated   — 1st of the month, validation summary to Sam
--
-- Multi-tenancy note: workflows.list filters by the requester's business_id,
-- so we have to attach one row per business or admins can't see them in
-- their own UI. The worker's isAutomationPaused() doesn't filter by
-- business — that pre-existing global-pause semantics is out of scope here;
-- pausing in any tenant currently stops the cron for all, matching the
-- system's de-facto single-tenant operation.
--
-- Idempotent in two ways:
--   * `NOT EXISTS (business_id, handler_key)` — re-running the migration
--     never inserts a duplicate row for the same tenant + handler.
--   * Filter excludes load-test tenants and inactive businesses so the
--     migration stays tidy on dev DBs that have been used for stress tests.

INSERT INTO workflows (id, business_id, name, description, type, handler_key, schedule, status)
SELECT
  gen_random_uuid(),
  b.id,
  'Chase overdue invoices',
  'Daily — emails the billing contact for every invoice past its due date.',
  'scheduled',
  'chase-overdue',
  'Daily 09:00 UTC',
  'active'
FROM businesses b
WHERE b.status = 'active'
  AND b.name NOT LIKE '[LOAD-TEST]%'
  AND NOT EXISTS (
    SELECT 1 FROM workflows w
    WHERE w.business_id = b.id AND w.handler_key = 'chase-overdue'
  );

INSERT INTO workflows (id, business_id, name, description, type, handler_key, schedule, status)
SELECT
  gen_random_uuid(),
  b.id,
  'Auto-invoice (weekly)',
  'Mondays 09:00 UTC — drafts a Xero invoice for every weekly_auto client based on the prior Mon-Sun lead deliveries.',
  'scheduled',
  'auto-invoice',
  'Mondays 09:00 UTC',
  'active'
FROM businesses b
WHERE b.status = 'active'
  AND b.name NOT LIKE '[LOAD-TEST]%'
  AND NOT EXISTS (
    SELECT 1 FROM workflows w
    WHERE w.business_id = b.id AND w.handler_key = 'auto-invoice'
  );

INSERT INTO workflows (id, business_id, name, description, type, handler_key, schedule, status)
SELECT
  gen_random_uuid(),
  b.id,
  'Monthly validation report',
  'First of each month — emails Sam a per-client lead-volume summary for the previous month so he can request sign-off before invoicing.',
  'scheduled',
  'monthly-validated',
  'Monthly · 1st 09:00 UTC',
  'active'
FROM businesses b
WHERE b.status = 'active'
  AND b.name NOT LIKE '[LOAD-TEST]%'
  AND NOT EXISTS (
    SELECT 1 FROM workflows w
    WHERE w.business_id = b.id AND w.handler_key = 'monthly-validated'
  );
