-- Slice 1 Day 1: split free-text address into 5 structured fields and add
-- VAT number + VAT rate so agreement auto-fill (Sam's Loom ask #57, #58, #82)
-- has the data it needs.
--
-- The legacy `address` column is preserved for backwards compatibility —
-- existing rows in production keep their free-text address; new rows fill
-- the 5 structured fields. UI can render whichever side is populated.
--
-- Idempotent: safe to re-run on every deploy.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS address_line VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_town VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_county VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_country VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_postcode VARCHAR(20),
  ADD COLUMN IF NOT EXISTS vat_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5, 2) DEFAULT 20.00;
