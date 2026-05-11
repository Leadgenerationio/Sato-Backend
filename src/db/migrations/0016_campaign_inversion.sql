-- Slice 2 Day 1: Sam Loom #40-46 — campaign concept inversion.
--
-- Before: each `campaigns` row = one (client × vertical) pair. "Solar Panels"
-- appears N times if N clients buy it.
-- After: `campaigns` = the vertical itself. Buyers link via new
-- `client_campaigns` table. Existing data is preserved end-to-end via a
-- non-destructive backfill.
--
-- Idempotent: safe to re-run on every deploy.

-- 1) Make campaigns.client_id nullable so new vertical-only campaign rows
--    can omit it. Old rows keep their client_id.
ALTER TABLE campaigns ALTER COLUMN client_id DROP NOT NULL;

-- 2) Add cost-per-lead column (Sam #41 quick-win — supplier cost, distinct
--    from buyer price). Default null until populated by sync from Catchr.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS cost_per_lead DECIMAL(10, 2);

-- 3) Vertical index — most list queries filter or group by it.
CREATE INDEX IF NOT EXISTS campaigns_vertical_idx ON campaigns(vertical);

-- 4) New join table — many-to-many between clients and campaigns.
CREATE TABLE IF NOT EXISTS client_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_price DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'GBP',
  status VARCHAR(20) DEFAULT 'active',
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_campaigns_client_idx ON client_campaigns(client_id);
CREATE INDEX IF NOT EXISTS client_campaigns_campaign_idx ON client_campaigns(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS client_campaigns_unique_idx ON client_campaigns(client_id, campaign_id);

-- 5) Backfill from existing campaigns.client_id — one join row per legacy
--    campaign. ON CONFLICT ignores re-runs.
INSERT INTO client_campaigns (client_id, campaign_id, lead_price, currency, status, started_at)
SELECT
  c.client_id,
  c.id,
  c.lead_price,
  COALESCE(c.currency, 'GBP'),
  COALESCE(c.status, 'active'),
  COALESCE(c.start_date, c.created_at, NOW())
FROM campaigns c
WHERE c.client_id IS NOT NULL
ON CONFLICT (client_id, campaign_id) DO NOTHING;
