-- Sam feedback 2026-09-29 (M5 / S4): one "VAT registered" tick drove both
-- vat_registered and add_vat_to_invoices, so there was no way to set up a
-- zero-rated, reverse-charge or outside-scope client (EUR invoices for a
-- Polish client were getting "Add VAT (20%)").
--
-- vat_treatment is the single source of truth going forward:
--   uk_standard     UK VAT at the client's vat_rate (VAT line on the invoice)
--   uk_zero_rated   UK VAT registered, zero-rated supply (no VAT line)
--   reverse_charge  EU / international B2B, customer accounts for VAT (no VAT line)
--   outside_scope   no VAT (no VAT line)
-- The app keeps writing vat_registered / add_vat_to_invoices from it so
-- older readers stay consistent (see src/utils/client-locale.ts vatFlagsFor).
--
-- Nullable with NO default on purpose: auto-migrate re-runs every file on
-- every boot, so the backfill below must only touch rows that have never had
-- a treatment. A default would fill every row on ADD COLUMN and make the
-- backfill a no-op. The backfill keeps today's invoice behaviour (no client
-- gains or loses a VAT line): VAT was being added → uk_standard; registered
-- but not adding VAT → uk_zero_rated; neither → outside_scope. Admins should
-- review non-UK clients and switch them to reverse_charge where it applies.
--
-- Idempotent. Safe to re-run.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vat_treatment varchar(30);

UPDATE clients
  SET vat_treatment = CASE
    WHEN add_vat_to_invoices THEN 'uk_standard'
    WHEN vat_registered THEN 'uk_zero_rated'
    ELSE 'outside_scope'
  END
  WHERE vat_treatment IS NULL;
