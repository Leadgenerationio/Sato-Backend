-- T2 (Sam, 2026-05-20 meeting): staff-side "Submit for approval" gate.
--
-- Before this migration every creative became visible to the linked buyer
-- the moment it was uploaded — there was no draft state, no audit point
-- for "staff sent this for review", and no way to upload an unfinished
-- asset without leaking it. After this migration:
--
--   - creatives default to status='draft' on insert (only visible to staff)
--   - POST /creatives/:id/submit-for-approval flips draft → sent_for_approval
--   - portal queries filter status != 'draft' so drafts never reach buyers
--   - approve / reject / changes_requested write the matching status onto
--     creatives.status alongside the existing creative_approvals audit row
--
-- AC#2: existing creatives are visible to buyers in prod today; the
-- backfill flips them to 'sent_for_approval' (with submitted_at =
-- created_at as the best available approximation) so nothing disappears
-- from /portal/compliance mid-flight.

CREATE TYPE creative_status AS ENUM (
  'draft',
  'sent_for_approval',
  'approved',
  'rejected',
  'changes_requested'
);

ALTER TABLE creatives
  ADD COLUMN status creative_status NOT NULL DEFAULT 'draft';

ALTER TABLE creatives
  ADD COLUMN submitted_at TIMESTAMP WITH TIME ZONE;

-- Backfill: every existing creative row is treated as already-submitted
-- (preserves buyer-visibility). submitted_at falls back to created_at so
-- the timeline has a value to show.
UPDATE creatives
SET status = 'sent_for_approval'::creative_status,
    submitted_at = COALESCE(submitted_at, created_at, NOW())
WHERE status = 'draft';

CREATE INDEX creatives_status_idx ON creatives(status);

-- AC#7: every submit emits an audit row in creative_approvals so the
-- "who pushed this to the buyer, when?" question is answerable from the
-- same table that already records buyer approve/reject decisions. We
-- extend the existing enum rather than introduce a parallel audit
-- store — keeps the timeline one query away. IF NOT EXISTS is
-- idempotent + safe to re-run.
ALTER TYPE creative_approval_action ADD VALUE IF NOT EXISTS 'submitted';
