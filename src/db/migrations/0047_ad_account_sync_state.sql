-- Phase 3 of docs/creative-library-and-api-plan.md: scheduled pull of ads and
-- creatives from Meta and Taboola for every linked ad account.
--
-- One row per client_ad_accounts row: when it last ran, the last error (shown
-- on the Link ad accounts screen) and the counts from the last run. Kept in
-- its own table rather than as columns on client_ad_accounts so the link
-- record (who owns the account) stays separate from sync noise, and an unlink
-- (row delete) drops its sync state with it.
--
-- scripts/auto-migrate.ts re-applies every migration on every boot: this file
-- is DDL only, IF NOT EXISTS, and never touches data.
CREATE TABLE IF NOT EXISTS ad_account_sync_state (
  client_ad_account_id uuid PRIMARY KEY REFERENCES client_ad_accounts(id) ON DELETE CASCADE,
  last_run_at timestamptz,
  last_success_at timestamptz,
  -- High-water mark passed to the platform as "updated since" on the next run.
  cursor_since timestamptz,
  last_error text,
  last_error_at timestamptz,
  ads_seen integer NOT NULL DEFAULT 0,
  creatives_created integer NOT NULL DEFAULT 0,
  creatives_updated integer NOT NULL DEFAULT 0,
  creatives_failed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
