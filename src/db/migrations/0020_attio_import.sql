-- #39 Attio bulk import. Adds a column on clients to record which Attio
-- company a Stato client was imported from so re-imports dedupe instead
-- of creating duplicate rows.
--
-- Idempotent — safe to re-run on every deploy.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS attio_company_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS clients_attio_idx ON clients(attio_company_id);
