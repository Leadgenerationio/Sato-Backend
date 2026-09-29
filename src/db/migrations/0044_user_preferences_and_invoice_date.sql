-- Feedback round 1 (Sam, 29 Sep 2026).
--
-- N2: "Preferences only saved in this browser" — dashboard layout, campaign
-- grouping and task filters lived in localStorage, so they didn't follow the
-- user to another device. One jsonb bag per user, keyed by preference name
-- (validated by an allow-list in user.routes.ts). NULL = nothing saved yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb;
--> statement-breakpoint
-- S12: Xero-imported invoices showed the IMPORT date as "Created". Xero's own
-- invoice Date is stored here by the sync (xero-client/invoice.service) and
-- the list shows invoice_date when present, falling back to created_at for
-- invoices raised in Stato before they were pushed. Existing Xero rows are
-- backfilled on the next sync — the sync already re-upserts every invoice.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_date timestamp;
