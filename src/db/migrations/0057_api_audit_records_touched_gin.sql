-- Per-creative history (Settings → API keys → Activity filtered to one creative,
-- and get_asset's history) asks `records_touched @> '[{"type":"creative","id":…}]'`.
-- Without an index that scans every audit row of the business, and the log is
-- kept 12 months. jsonb_path_ops serves @> only, which is all we ask, and is
-- smaller than the default GIN opclass. The table is new (0055): a plain build
-- is fine, though it blocks audit writes while it runs (a moment at this size).
-- Idempotent on every boot (auto-migrate re-applies all). If this index ever
-- has to be rebuilt on a big table, do it by hand with CREATE INDEX
-- CONCURRENTLY, outside auto-migrate (like the creatives unique index script).
CREATE INDEX IF NOT EXISTS api_audit_log_records_touched_idx ON api_audit_log USING gin (records_touched jsonb_path_ops);
