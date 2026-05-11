-- SOP polish (Week 3 — items #104, #105, #107).
--
-- Adds three optional columns to support Sam's reference SOP flow:
--   loom_url    — single Loom video URL embedded on the SOP detail page (#104)
--   screenshots — jsonb array of uploaded screenshot file refs (#105)
--   tags        — text[] for multi-tag categorisation / access control (#107)
--
-- Idempotent: safe to re-run on every deploy.

ALTER TABLE sops ADD COLUMN IF NOT EXISTS loom_url varchar(500);
ALTER TABLE sops ADD COLUMN IF NOT EXISTS screenshots jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sops ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];

-- GIN index on tags so the future "filter by tag" UI doesn't full-scan the
-- sops table once the org has a few hundred SOPs.
CREATE INDEX IF NOT EXISTS sops_tags_idx ON sops USING gin(tags);
