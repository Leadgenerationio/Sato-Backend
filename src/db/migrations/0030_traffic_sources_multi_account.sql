-- Allow one traffic_sources row to roll up spend from multiple Catchr ad
-- accounts. Previously each row pointed at exactly one Facebook/Google/
-- Bing/etc. account via `account_id` — but Sam's campaigns often run
-- across 3-5 ad accounts on the same platform (Solar Panels UK pulls
-- spend from Solar Incentives + TheSolarGeeks + Solar Discounts + MYSOLAR
-- all at once), and there's no clean way to model that with the old
-- one-column-per-source design.
--
-- account_ids stores a JSONB array of Catchr account IDs. The legacy
-- account_id column stays as the "primary" / first account for
-- back-compat with rows created before this migration; new rows can
-- leave account_id empty and just fill account_ids.
--
-- Idempotent — safe to re-run.

ALTER TABLE traffic_sources
  ADD COLUMN IF NOT EXISTS account_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- No backfill needed: listSourcesForCampaign() unions account_id ∪
-- account_ids[] when summing ad_spend, so existing rows with only
-- account_id keep returning the same spend total.
