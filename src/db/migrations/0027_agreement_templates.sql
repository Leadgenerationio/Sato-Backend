-- 0027_agreement_templates.sql
-- Per-business agreement template library. PDF lives in R2; field_layout JSON
-- holds where each variable/signature/date sits on the template (pct coords,
-- top-left origin, matching the existing #47-50 editor).
--
-- Idempotent: every statement uses IF NOT EXISTS so this is safe to re-run.

CREATE TABLE IF NOT EXISTS agreement_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(500),
  pdf_r2_key VARCHAR(500) NOT NULL,
  field_layout JSONB NOT NULL DEFAULT '[]'::jsonb,
  signer_role VARCHAR(100),
  archived_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agreement_templates_business_active_idx
  ON agreement_templates(business_id, created_at)
  WHERE archived_at IS NULL;

ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES agreement_templates(id),
  ADD COLUMN IF NOT EXISTS populated_pdf_r2_key VARCHAR(500),
  ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
