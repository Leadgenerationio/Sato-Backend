-- Sam (2026-05-27 portal meeting): "we just select what we want to have
-- access to" — per-user tab visibility for the client portal.
--
-- A NULL value preserves today's behaviour (all tabs visible). A non-null
-- array of slugs means "user only sees these tabs" (plus dashboard +
-- account, which are always available). client_admin ignores this column
-- entirely — admins always see everything within their own portal.
--
-- Idempotent. Safe to re-run.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS allowed_tabs TEXT[];
