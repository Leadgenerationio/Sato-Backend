-- Sam feedback 2026-09-29 (S12): invoices imported from Xero showed the import
-- date as "Created". `created_at` is when Stato first saw the row; the date
-- Xero issued the invoice never reached the table. New nullable column.
--
-- auto-migrate re-runs every file on each boot, so both statements are
-- idempotent and the backfill only touches rows that are still NULL.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date timestamp;

-- Invoices raised in Stato (never imported from Xero): the moment they were
-- created is the issue date.
UPDATE invoices SET issue_date = created_at
WHERE issue_date IS NULL AND xero_invoice_id IS NULL;

-- Xero-imported rows are filled in by the next invoice sync (it now writes
-- Xero's Date on every run). Until then they show no issue date rather than
-- the import date.
