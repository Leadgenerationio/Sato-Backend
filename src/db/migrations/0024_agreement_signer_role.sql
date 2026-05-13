-- Sam Loom #68 — editable signatory role on agreement. Adds a nullable
-- varchar to record what title/role the signer is signing under
-- (e.g. "Director", "CEO", "Compliance Officer"). Distinct from the
-- workflow role SignNow uses internally ("Signer 1") — this is the
-- legal title that appears under the signature line + in audit logs.
--
-- Idempotent — safe to re-run on every deploy.

ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS signer_role VARCHAR(100);
