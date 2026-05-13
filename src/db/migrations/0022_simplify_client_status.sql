-- Sam Loom #31 — simplify client status to 3 values. Per Sam's 13 May
-- response: "Onboarding / Active Client / Client Churned (JUST THESE
-- FOR NOW)". Existing rows in the deprecated buckets migrate:
--   prospect → onboarding   (matches the "new client, not yet active" semantic)
--   paused   → churned      (paused was barely used; safer than inventing a 4th)
--
-- The Postgres enum type keeps its 5 values for now — removing enum values
-- is not idempotent in PG, and the app code + zod accept-list will block
-- 'prospect'/'paused' from ever being written again. If we want to drop
-- them from the type later, do it in a dedicated migration after a
-- "no orphans" check.
--
-- Idempotent — UPDATEs on already-migrated rows are no-ops.

UPDATE clients SET status = 'onboarding' WHERE status = 'prospect';
UPDATE clients SET status = 'churned'    WHERE status = 'paused';
