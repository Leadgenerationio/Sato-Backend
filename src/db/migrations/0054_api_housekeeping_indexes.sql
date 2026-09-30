-- The daily api-housekeeping purge deletes by age; without these it scans the
-- whole table. DDL only, idempotent on every boot (auto-migrate re-applies all).
CREATE INDEX IF NOT EXISTS api_key_usage_at_idx ON api_key_usage (at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
