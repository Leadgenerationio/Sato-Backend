-- Sam feedback 2026-09-29 (S4): the Xero tax type for each VAT treatment
-- was hard-coded (reverse charge went as NONE "until the accountant
-- confirms"). The Owner now sets it in Settings → Integrations → Xero.
--
-- Only overrides are stored; the defaults (today's behaviour) live in
-- src/services/business-settings.service.ts. No backfill, so auto-migrate
-- re-running this file on every boot never touches a saved setting.
CREATE TABLE IF NOT EXISTS business_settings (
  business_id    uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  xero_tax_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
