-- #47-50 PDF editor with drag-place fields. Adds a JSONB column to
-- agreements that stores the placed-field array from the editor UI
-- (signature / date_signed / text boxes positioned by the user before
-- send). NULL means free-form invite (legacy flow, signer places
-- wherever); non-null means role-based invite with pre-placed fields.
--
-- Idempotent — safe to re-run on every deploy.

ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS fields JSONB;
