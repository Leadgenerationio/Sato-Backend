-- Sam (2026-06-10): self-service forgot-password via a 6-digit emailed code.
--
-- One row per reset request. The code is never stored in plaintext — only
-- its bcrypt hash. A row is "live" while consumed_at IS NULL, expires_at is
-- in the future, and attempts < 5. Requesting a new code soft-invalidates
-- prior live rows for the same email. See
-- src/services/password-reset.service.ts.
--
-- Idempotent: safe to re-run on every deploy.

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL,
  code_hash varchar(255) NOT NULL,
  expires_at timestamp NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets(email);
CREATE INDEX IF NOT EXISTS password_resets_expires_at_idx ON password_resets(expires_at);
