-- Piece 3 — populate lead_deliveries from LeadByte. The writer uses
-- INSERT ... ON CONFLICT (campaign_id, client_id, delivery_date) DO UPDATE
-- so the same daily row can be safely re-pulled on every sync (idempotent
-- backfill). Without a unique index, ON CONFLICT has no target and Postgres
-- rejects the upsert. Adds the index idempotently so re-runs are no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS lead_deliveries_camp_client_date_unique
  ON lead_deliveries (campaign_id, client_id, delivery_date);
