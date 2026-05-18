-- Creative review (Sam #9/#11 — 2026-05-17 confirm). Splits assets into two
-- buyer-facing sections so the portal review tab can render them as separate
-- cards. Adds a third decision state because Sam's flow is approve / reject /
-- request-changes, not the binary approve/reject we had before.
--
-- Idempotent — safe to re-run.

-- 1. Add the section enum column to creatives. NOT NULL with default 'media'
-- so the 0-row prod table backfills cleanly and any code that doesn't pass
-- section still works (image/video assets are the common case).
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS section VARCHAR(16) NOT NULL DEFAULT 'media';

-- Index so the portal split-list query stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS creatives_section_idx ON creatives (section);

-- 2. Extend the creative_approval_action enum with 'changes_requested'.
-- ADD VALUE IF NOT EXISTS is idempotent in Postgres 14+. The value name
-- matches the FE convention (snake_case) so the API layer can pass through
-- without translation.
ALTER TYPE creative_approval_action ADD VALUE IF NOT EXISTS 'changes_requested';
