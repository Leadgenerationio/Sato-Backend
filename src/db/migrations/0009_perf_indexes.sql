-- Performance indexes — list endpoints scale poorly without these.
-- All idempotent (IF NOT EXISTS) so re-running is a no-op.

-- Clients: most filter queries combine businessId + status (Active tab,
-- Prospect tab, etc.). Without this composite, Postgres uses single-column
-- business_idx and re-checks status on every row.
CREATE INDEX IF NOT EXISTS clients_business_status_idx
  ON clients (business_id, status);

-- Invoices: dashboard "Recent Invoices" + every list page does
-- ORDER BY created_at DESC LIMIT N. Without this, Postgres sorts the whole
-- table on every list request. Combined with status filtering for the
-- "draft / overdue / paid" tabs.
-- Note: invoices doesn't have business_id directly — business scoping is
-- via client_id JOIN, so the composite is (client_id, status).
CREATE INDEX IF NOT EXISTS invoices_created_idx
  ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_client_status_idx
  ON invoices (client_id, status);

-- Notifications: every dashboard render queries unread-by-user, every
-- markAllAsRead updates by-user-where-unread. Composite covers both.
CREATE INDEX IF NOT EXISTS notifications_user_read_idx
  ON notifications (user_id, read);

-- Bank transactions: P&L summary filters by businessId + date range.
-- The single-column business_idx and date_idx don't compose well; this
-- composite makes "WHERE business_id = ? AND date >= ?" index-only.
CREATE INDEX IF NOT EXISTS bank_tx_business_date_idx
  ON bank_transactions (business_id, date DESC);

-- Campaigns: list page filters by status + sorts by name. Single-column
-- client_idx already exists.
CREATE INDEX IF NOT EXISTS campaigns_status_idx
  ON campaigns (status);

-- Lead deliveries: dashboard "leads-by-day" aggregates by date for a given
-- business, joined through clients. The composite (clientId, deliveryDate)
-- speeds up the per-client P&L too.
CREATE INDEX IF NOT EXISTS lead_deliveries_client_date_idx
  ON lead_deliveries (client_id, delivery_date DESC);

-- Tasks: kanban / list filtering by status (todo / in-progress / done) plus
-- assignee. Composite covers both common access patterns.
CREATE INDEX IF NOT EXISTS tasks_assignee_status_idx
  ON tasks (assignee, status);

-- Agreements: list filters by client + status. agreements doesn't have
-- business_id directly — scoping is via client_id JOIN like invoices.
CREATE INDEX IF NOT EXISTS agreements_client_status_idx
  ON agreements (client_id, status);
