-- S8 + N6 (Sam feedback round 1, 29 Sep 2026): let the Owner resolve the
-- security tidy-up and the test data from inside the portal.
--   users.access_expires_at — time-limited access (e.g. the agency). NULL = no end.
--   archived_at on sos_help_requests / sops / staff — soft-archive; rows are
--     hidden from lists but never deleted (audit + history stay intact).
--   admin_cleanup_log — one row per "Apply" on Settings → Clean up.
--
-- Idempotent: scripts/auto-migrate.ts re-applies every file on every boot.
-- Schema-only (no data statements), so nothing a user changed is overwritten.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at timestamptz;
ALTER TABLE sos_help_requests ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE sops ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE TABLE IF NOT EXISTS admin_cleanup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_cleanup_log_business_idx ON admin_cleanup_log (business_id, created_at);
