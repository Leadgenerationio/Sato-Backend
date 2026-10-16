// The name of the unique index "one live creative per (client, file hash)". It lives in a file of its own, with no imports, so
// the operational scripts (scripts/check-creative-duplicates.ts, create-creative-unique-index.ts) can use it inside the production
// Docker image, which does not contain src/db/schema. The Dockerfile copies exactly this file for them; the schema re-exports it
// and the race handlers (utils/pg-errors.ts) match violations against it.
export const CREATIVE_CLIENT_SHA_INDEX = 'creatives_client_sha256_live_uq';

// The name of the unique index "one creative per (platform, platform_creative_id)" (migration 0045). Matched the same
// way, so a concurrent sync of the same platform creative id answers duplicate instead of a 500.
export const CREATIVE_PLATFORM_CREATIVE_INDEX = 'creatives_platform_creative_uq';
