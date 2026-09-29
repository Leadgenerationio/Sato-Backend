-- N8 (Sam feedback round 1, 29 Sep 2026): creatives.file_url held the
-- upload-time presigned download URL (expires in 1 h, carries X-Amz-*
-- signing params). Keep the object path — resolveR2Location() parses the
-- R2 folder from it — and drop the signing query. Readers already mint a
-- fresh signed URL per request.
--
-- Idempotent: auto-migrate re-runs every file on boot; once stripped, a row
-- no longer matches the WHERE clause.
UPDATE creatives
SET file_url = split_part(file_url, '?', 1),
    updated_at = now()
WHERE file_url ~* '[?&]X-Amz-(Signature|Credential|Expires)=';
