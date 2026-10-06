-- MCP connector spec v1.0, step 1a (schema). Every statement is re-runnable:
-- auto-migrate re-applies all files on every boot, so each one is IF NOT
-- EXISTS / a no-op when already done. DDL plus one backfill, no data deleted.

-- ─── creatives ───────────────────────────────────────────────────────────
-- A 4 GB video does not fit a 32-bit integer (max ~2.1 GB). Same type again
-- is a no-op on later boots.
ALTER TABLE creatives ALTER COLUMN size_bytes TYPE bigint;
--> statement-breakpoint
-- Copy-only assets (type = 'copy', headline/body text, no file).
ALTER TABLE creatives ALTER COLUMN file_url DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- processing -> ready | failed. Existing rows are files already stored.
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS file_status varchar(16) NOT NULL DEFAULT 'ready';
--> statement-breakpoint
-- Where the row came from: portal | api | mcp | sync.
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'portal';
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS created_by_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creatives_archived_at_idx ON creatives (archived_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creatives_file_status_idx ON creatives (file_status) WHERE file_status <> 'ready';
--> statement-breakpoint

-- ─── creative_ad_links ───────────────────────────────────────────────────
-- One row per ad a creative is used in. A creative can sit in several ads, an
-- ad account can feed several campaigns (campaign_id lives here, not only on
-- client_ad_accounts). The old single platform_* columns on creatives stay,
-- read-only, for two releases so the portal and the Meta/Taboola pull keep
-- working. platform uses the creatives.platform vocabulary (meta, taboola,
-- google, tiktok).
CREATE TABLE IF NOT EXISTS creative_ad_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  creative_id uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL,
  platform_account_id varchar(100),
  platform_campaign_id varchar(100),
  platform_adset_id varchar(100),
  platform_ad_id varchar(100),
  platform_creative_id varchar(100),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  status varchar(10) NOT NULL DEFAULT 'active',
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_by_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  CONSTRAINT creative_ad_links_status_chk CHECK (status IN ('active', 'unlinked')),
  CONSTRAINT creative_ad_links_has_id_chk CHECK (platform_ad_id IS NOT NULL OR platform_creative_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creative_ad_links_creative_idx ON creative_ad_links (creative_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creative_ad_links_business_idx ON creative_ad_links (business_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creative_ad_links_campaign_idx ON creative_ad_links (campaign_id);
--> statement-breakpoint
-- Backfill: one active link per creative that already has a platform ad or
-- creative ID. Oldest creative wins when two share an ad ID, the rest stay
-- unlinked (the unique index below needs one owner per ad). Creatives with no
-- client have no business to file the link under and are skipped. Safe to
-- re-run: a creative that already has a link is never inserted again.
INSERT INTO creative_ad_links (business_id, creative_id, platform, platform_account_id, platform_campaign_id, platform_ad_id, platform_creative_id, campaign_id, created_at)
SELECT DISTINCT ON (c.platform, COALESCE(c.platform_ad_id, 'creative:' || c.platform_creative_id))
       cl.business_id, c.id, c.platform, c.platform_account_id, c.platform_campaign_id, c.platform_ad_id, c.platform_creative_id, c.campaign_id,
       COALESCE(c.created_at, now())
FROM creatives c
JOIN clients cl ON cl.id = c.client_id
WHERE c.platform IS NOT NULL AND c.platform <> 'manual'
  AND (c.platform_ad_id IS NOT NULL OR c.platform_creative_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM creative_ad_links l WHERE l.creative_id = c.id)
  AND NOT EXISTS (
    SELECT 1 FROM creative_ad_links l
    WHERE l.status = 'active' AND l.platform = c.platform
      AND l.platform_ad_id IS NOT DISTINCT FROM c.platform_ad_id
      AND l.platform_creative_id IS NOT DISTINCT FROM c.platform_creative_id
  )
ORDER BY c.platform, COALESCE(c.platform_ad_id, 'creative:' || c.platform_creative_id), c.created_at NULLS LAST, c.id;
--> statement-breakpoint
-- One owner per ad. Created after the backfill so the backfill never trips it.
-- The table is new, so a plain (non-concurrent) build is safe here.
CREATE UNIQUE INDEX IF NOT EXISTS creative_ad_links_ad_uq
  ON creative_ad_links (platform, platform_ad_id)
  WHERE status = 'active' AND platform_ad_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS creative_ad_links_creative_uq
  ON creative_ad_links (creative_id, platform, COALESCE(platform_ad_id, ''), COALESCE(platform_creative_id, ''))
  WHERE status = 'active';
--> statement-breakpoint

-- ─── uploads ─────────────────────────────────────────────────────────────
-- One row per direct/multipart/URL upload, so a job stuck on processing can be
-- found and swept, and an abandoned multipart upload can be aborted.
CREATE TABLE IF NOT EXISTS uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  filename varchar(255) NOT NULL,
  content_type varchar(120),
  size_bytes bigint,
  sha256 char(64),
  r2_key varchar(500) NOT NULL,
  mode varchar(10) NOT NULL,
  multipart_upload_id varchar(500),
  part_size bigint,
  status varchar(12) NOT NULL DEFAULT 'created',
  error text,
  creative_id uuid REFERENCES creatives(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uploads_mode_chk CHECK (mode IN ('single', 'multipart', 'url')),
  CONSTRAINT uploads_status_chk CHECK (status IN ('created', 'uploading', 'processing', 'ready', 'failed', 'aborted', 'expired'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS uploads_business_idx ON uploads (business_id);
--> statement-breakpoint
-- The sweeper looks for unfinished uploads by age.
CREATE INDEX IF NOT EXISTS uploads_open_idx ON uploads (status, updated_at) WHERE status IN ('created', 'uploading', 'processing');
--> statement-breakpoint

-- ─── client_ad_accounts ──────────────────────────────────────────────────
-- A confirmed move is recorded on the row (and in the audit log).
ALTER TABLE client_ad_accounts ADD COLUMN IF NOT EXISTS moved_from_client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE client_ad_accounts ADD COLUMN IF NOT EXISTS moved_at timestamptz;
--> statement-breakpoint
-- Store the normalised account ID (no act_ on Meta, no dashes on Google), the
-- same rule the API now applies on write. Rows that would collide with an
-- already-normalised row are left alone.
UPDATE client_ad_accounts c
SET account_id = regexp_replace(c.account_id, '^act_', '', 'i')
WHERE c.platform = 'facebook-ads' AND c.account_id ~* '^act_'
  AND NOT EXISTS (SELECT 1 FROM client_ad_accounts o WHERE o.platform = c.platform AND o.account_id = regexp_replace(c.account_id, '^act_', '', 'i'));
--> statement-breakpoint
UPDATE client_ad_accounts c
SET account_id = replace(c.account_id, '-', '')
WHERE c.platform = 'google-ads' AND c.account_id LIKE '%-%'
  AND NOT EXISTS (SELECT 1 FROM client_ad_accounts o WHERE o.platform = c.platform AND o.account_id = replace(c.account_id, '-', ''));
--> statement-breakpoint

-- ─── api_keys ────────────────────────────────────────────────────────────
-- NULL allowed_client_ids = the key sees every client in its business.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_client_ids uuid[];
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_label varchar(100);
--> statement-breakpoint

-- ─── api_audit_log ───────────────────────────────────────────────────────
-- One row per API/MCP call (api_key_usage only keeps method, path, status).
-- Arguments are stored redacted; before/after hold the changed records.
CREATE TABLE IF NOT EXISTS api_audit_log (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  key_name varchar(100),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  agent varchar(100),
  transport varchar(4) NOT NULL DEFAULT 'rest',
  tool varchar(100),
  method varchar(8),
  path varchar(300),
  status integer,
  error_code varchar(60),
  args jsonb,
  result jsonb,
  records_touched jsonb,
  before jsonb,
  after jsonb,
  duration_ms integer,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_audit_log_transport_chk CHECK (transport IN ('rest', 'mcp'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_audit_log_business_at_idx ON api_audit_log (business_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_audit_log_key_at_idx ON api_audit_log (api_key_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_audit_log_at_idx ON api_audit_log (at);
