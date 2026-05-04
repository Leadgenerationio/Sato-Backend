-- Migrate auth from in-memory store to DB. The users table itself already
-- exists (migration 0000); this only adds the column the in-memory store
-- carried as a derived flag. Idempotent — safe to re-run.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_primary_owner" boolean NOT NULL DEFAULT false;
