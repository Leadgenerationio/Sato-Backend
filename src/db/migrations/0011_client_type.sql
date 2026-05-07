-- Adds client_type enum + column on clients table.
-- `managed` = bundled monthly retainer (e.g. Tomic Zero); portal hides ad-spend
-- and capture-cost widgets, no per-lead pricing visible.
-- `ppl` = pay-per-lead (default for all existing clients).
--
-- Idempotent: safe to re-run on every deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'client_type') THEN
    CREATE TYPE client_type AS ENUM ('managed', 'ppl');
  END IF;
END $$;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS client_type client_type NOT NULL DEFAULT 'ppl';
