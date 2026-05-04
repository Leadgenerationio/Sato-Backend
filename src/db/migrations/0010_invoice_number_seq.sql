-- Generate invoice numbers via a Postgres SEQUENCE instead of count(*) inside
-- a transaction. The previous implementation in invoice.service.ts:228 ran
-- `SELECT count(*) FROM invoices` for every create — O(n) and racy under
-- concurrent writes (two simultaneous transactions can both see the same
-- count and produce the same INV-N number).
--
-- Idempotent and safe to re-run on every deploy:
--   - CREATE SEQUENCE IF NOT EXISTS only creates on first deploy.
--   - setval only fires when the sequence has fallen behind the highest
--     existing INV-N number (e.g. when invoices were inserted manually or
--     migrated from another system after the sequence was created). On a
--     normal redeploy the sequence is already ahead of every row and the
--     DO block is a no-op.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1001 MINVALUE 1001;

DO $$
DECLARE
  current_max integer;
  current_seq integer;
BEGIN
  -- Parse the numeric tail of every invoice_number (handles 'INV-1234' →
  -- 1234, ignores rows that don't match). NULLIF guards the empty-string
  -- case when a row has no digits.
  SELECT COALESCE(
    MAX(NULLIF(regexp_replace(invoice_number, '\D', '', 'g'), '')::integer),
    1000
  )
  INTO current_max
  FROM invoices
  WHERE invoice_number IS NOT NULL;

  SELECT last_value INTO current_seq FROM invoice_number_seq;

  IF current_max >= current_seq THEN
    -- Advance the sequence past the highest existing number.
    PERFORM setval('invoice_number_seq', current_max);
    RAISE NOTICE 'invoice_number_seq advanced to %', current_max;
  END IF;
END $$;
