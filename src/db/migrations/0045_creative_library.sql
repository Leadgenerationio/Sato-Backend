-- Creative library + landing pages per client (Sam feedback round 1, M2;
-- plan: docs/creative-library-and-api-plan.md, phase 1).
--
-- scripts/auto-migrate.ts re-applies EVERY migration on EVERY boot, so all
-- of this is idempotent: IF NOT EXISTS on DDL, and the one backfill only
-- touches rows whose client_id is still NULL — a creative a user has since
-- moved to another client is never reassigned.

ALTER TABLE creatives ALTER COLUMN campaign_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE landing_pages ALTER COLUMN campaign_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS normalised_url varchar(500);
--> statement-breakpoint
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS title varchar(255);
--> statement-breakpoint
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS screenshot_key varchar(500);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS landing_pages_client_url_uq ON landing_pages (client_id, normalised_url) WHERE client_id IS NOT NULL AND normalised_url IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS landing_pages_client_idx ON landing_pages (client_id);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform varchar(20);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform_account_id varchar(100);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform_ad_id varchar(100);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform_creative_id varchar(100);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform_campaign_id varchar(100);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS platform_campaign_name varchar(255);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS landing_page_id uuid REFERENCES landing_pages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS headline text;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS body_text text;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS width integer;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS height integer;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS duration_s numeric(8,2);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS sha256 char(64);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS thumbnail_key varchar(500);
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS first_seen timestamptz;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS last_seen timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS creatives_platform_creative_uq ON creatives (platform, platform_creative_id) WHERE platform_creative_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creatives_client_idx ON creatives (client_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creatives_sha256_idx ON creatives (sha256);
--> statement-breakpoint
-- Backfill: a creative on a campaign with exactly ONE buyer belongs to that
-- buyer. Campaigns with several buyers stay shared (client_id NULL → shown
-- under every buyer). Only NULL rows are touched, so a later manual move
-- survives every re-run.
UPDATE creatives c
SET client_id = one.client_id
FROM (
  SELECT campaign_id, min(client_id::text)::uuid AS client_id
  FROM client_campaigns
  GROUP BY campaign_id
  HAVING count(DISTINCT client_id) = 1
) one
WHERE c.client_id IS NULL
  AND c.campaign_id = one.campaign_id
  AND c.platform IS NULL;
