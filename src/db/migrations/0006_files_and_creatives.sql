-- File attachments per invoice (stored as JSONB so we can ship without a
-- separate child table). Each element shape:
--   { key: string, name: string, size: number, contentType: string,
--     uploadedAt: string ISO, uploadedBy?: string }
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Staff documents (contracts, NDAs, payslips). Same JSONB shape as invoice
-- attachments, plus an optional `category` field.
ALTER TABLE "staff"
  ADD COLUMN IF NOT EXISTS "documents" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Creatives table already exists from 0000. Add the metadata fields we
-- want for the admin page: provider key (R2 path), file size, content type,
-- and a soft-delete flag so a deletion doesn't orphan campaign references.
ALTER TABLE "creatives"
  ADD COLUMN IF NOT EXISTS "r2_key" varchar(500),
  ADD COLUMN IF NOT EXISTS "size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "content_type" varchar(120),
  ADD COLUMN IF NOT EXISTS "uploaded_by" uuid REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "creatives_campaign_idx" ON "creatives" ("campaign_id");
CREATE INDEX IF NOT EXISTS "creatives_is_deleted_idx" ON "creatives" ("is_deleted");
