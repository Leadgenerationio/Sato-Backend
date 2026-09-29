-- Sam S13 (feedback round 1, 2026-09-29): "Only 3 of 14 active campaigns are
-- linked to a client. £586,065.73 of ad spend in the last 30 days isn't
-- linked to any campaign. Linking is one page at a time."
--
-- A campaign is a vertical shared by several buyers (client_campaigns), so
-- "ad account → campaign → client" can't name the one client an ad account
-- belongs to. This table records it directly: one row per ad account,
-- matched on (platform, account_id) — never on the account NAME, because
-- some Taboola names don't match their ids. campaign_id is optional.
-- It is also the lookup the planned public API uses
-- (docs/creative-library-and-api-plan.md, GET /clients/lookup).
--
-- platform holds canonicalizePlatform() output ('facebook-ads', 'google-ads',
-- 'tik-tok', 'taboola', 'bing-ads') so "Facebook" and "facebook-ads" can't
-- create two rows for the same account.
CREATE TABLE IF NOT EXISTS client_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  platform varchar(50) NOT NULL,
  account_id varchar(100) NOT NULL,
  -- Display only (last name seen in Catchr). Never used for matching.
  account_name varchar(255),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  currency varchar(3),
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS client_ad_accounts_platform_account_uq ON client_ad_accounts (platform, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS client_ad_accounts_client_idx ON client_ad_accounts (client_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS client_ad_accounts_business_idx ON client_ad_accounts (business_id);
