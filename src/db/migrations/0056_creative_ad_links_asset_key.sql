-- creative_ad_links_creative_uq (0055) keyed an ad-less link on creative +
-- platform + platform creative ID and ignored platform_asset_id, so a second
-- asset on the same creative (a second Meta video, say) hit the index and was
-- refused. The asset ID is part of the key now. 0055 stays as it is; this file
-- rebuilds the index only when it still has the old definition, so every boot
-- after the first is a no-op. The table is new and small: a plain build is fine.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'creative_ad_links_creative_uq' AND indexdef NOT LIKE '%platform_asset_id%') THEN
    DROP INDEX creative_ad_links_creative_uq;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS creative_ad_links_creative_uq
  ON creative_ad_links (creative_id, platform, COALESCE(platform_ad_id, ''), COALESCE(platform_creative_id, ''), COALESCE(platform_asset_id, ''))
  WHERE status <> 'removed';
