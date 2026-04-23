-- Rename the DocuSign-specific column to a provider-neutral name so
-- swapping to SignNow (and any future provider) doesn't require another
-- schema change. Existing data is preserved; the index on the column is
-- automatically retargeted by Postgres.
ALTER TABLE "agreements" RENAME COLUMN "docusign_envelope_id" TO "provider_envelope_id";
