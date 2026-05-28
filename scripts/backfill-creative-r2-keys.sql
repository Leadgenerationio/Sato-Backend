-- Backfill r2_key on creatives where it's NULL.
--
-- Context: every agency-side upload before this fix went into the misc/
-- R2 folder via FileUpload folder="misc" on campaigns/detail.tsx. The
-- creatives.r2_key column is nullable and was sometimes left NULL for
-- legacy rows. The new GET /portal/creatives/:id/signed-url and
-- GET /creatives/:id/signed-url endpoints parse file_url at read time
-- and recover (folder, key) from the URL path, so opens already work
-- WITHOUT this backfill running. This script just brings r2_key into
-- sync with reality so admin queries / future code that reads r2_key
-- aren't confused by the NULLs.
--
-- Step 1 — diagnostic. Run this FIRST and confirm the counts before
-- you run the UPDATEs in step 3.

-- 1a. How many live rows are missing r2_key?
SELECT count(*) AS null_r2_key_count
FROM creatives
WHERE r2_key IS NULL
  AND is_deleted = false;

-- 1b. Sample 10 of them to inspect the file_url shape. The path between
--     the bucket and the query-string is what we'll parse out as
--     <folder>/<key>.
SELECT id, name, file_url, created_at
FROM creatives
WHERE r2_key IS NULL
  AND is_deleted = false
ORDER BY created_at DESC
LIMIT 10;

-- 1c. Folder distribution across ALL rows (NULL r2_key or not) — sanity
--     check that the only folders in production are 'misc' and 'creatives'.
--     Anything else means the parser would have to learn a new prefix.
SELECT
  substring(
    regexp_replace(file_url, '^https?://[^/]+/', '')   -- drop scheme + host
    FROM '^([^/?]+/[^/?]+)'                            -- first two path segments
  ) AS bucket_folder,
  count(*)
FROM creatives
WHERE is_deleted = false
GROUP BY 1
ORDER BY 2 DESC;

-- ─────────────────────────────────────────────────────────────────────
-- Step 2 — dry-run the backfill. SELECT what would change without
-- writing anything, so you can spot-check 5-10 rows by eye.

SELECT
  id,
  name,
  file_url,
  -- key = everything after the last folder segment, with the query string
  -- chopped off. For a typical file_url like
  --   https://<account>.r2.cloudflarestorage.com/stato-production/misc/1779-foo.png?X-Amz-...
  -- this strips to "1779-foo.png".
  regexp_replace(
    split_part(file_url, '?', 1),    -- drop query string
    '^.*/',                          -- drop everything up to and including last '/'
    ''
  ) AS recovered_key
FROM creatives
WHERE r2_key IS NULL
  AND is_deleted = false
  AND file_url ~ '/(misc|creatives|invoices|agreements|landing-pages|sops)/'  -- only rows whose URL clearly contains a known R2 folder
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────
-- Step 3 — the actual backfill. Run inside a transaction so you can
-- ROLLBACK if the row counts don't match what step 2 previewed.
--
-- Idempotent (WHERE r2_key IS NULL). Skips any row whose file_url
-- doesn't contain a recognised folder segment — those need manual
-- inspection rather than a guess.

BEGIN;

UPDATE creatives
SET r2_key = regexp_replace(
    split_part(file_url, '?', 1),
    '^.*/',
    ''
  ),
  updated_at = now()
WHERE r2_key IS NULL
  AND is_deleted = false
  AND file_url ~ '/(misc|creatives|invoices|agreements|landing-pages|sops)/';

-- Sanity: how many rows still have NULL r2_key after the update?
-- Should be 0 unless some file_urls had unexpected shapes.
SELECT count(*) AS still_null_r2_key
FROM creatives
WHERE r2_key IS NULL
  AND is_deleted = false;

-- Inspect any remaining NULLs before committing.
SELECT id, name, file_url
FROM creatives
WHERE r2_key IS NULL
  AND is_deleted = false
LIMIT 20;

-- COMMIT;     -- uncomment after you've verified the counts above
-- ROLLBACK;   -- or roll back if anything looks off
