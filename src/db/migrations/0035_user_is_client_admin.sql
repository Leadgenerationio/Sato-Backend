-- Manual agreement-status override (client-dashboard, launch-blocker).
-- Client admins can correct a misleading "pending agreement, action needed"
-- alert for clients who signed outside Stato. The portal has no intra-client
-- role distinction today (every portal user is role='client'), so we add a
-- per-user `is_client_admin` flag — only flagged users get the write control;
-- everyone else sees the status read-only. Mirrors the existing
-- `is_primary_owner` flag pattern (agency-side) rather than expanding the
-- user_role enum, which would touch RBAC app-wide.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Defaults false (fail-closed — no
-- existing user gains the capability until explicitly flagged).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_client_admin BOOLEAN NOT NULL DEFAULT false;
