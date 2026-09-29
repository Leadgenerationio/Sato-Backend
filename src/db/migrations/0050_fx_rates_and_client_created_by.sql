-- Feedback round 1 (Sam, 29 Sep 2026).
--
-- M3: "Only add amounts together after converting them to £, and say that
-- they were converted (with the rate and date)." Daily ECB reference rates,
-- stored as base→quote (base is always GBP here: 1 GBP = `rate` units of
-- `quote`). One row per pair per publication date; the job upserts.
-- Idempotent: auto-migrate re-runs every file on every boot.
CREATE TABLE IF NOT EXISTS fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base varchar(3) NOT NULL,
  quote varchar(3) NOT NULL,
  rate numeric(18, 8) NOT NULL,
  rate_date date NOT NULL,
  source varchar(50) NOT NULL,
  fetched_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_pair_date_uq ON fx_rates (base, quote, rate_date);
--> statement-breakpoint
-- S14: "filters (currency, country, owner)". Who added the client. NULL for
-- every client created before this column existed (shown as "Unknown").
ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clients_created_by_idx ON clients (created_by);
