-- Auto-invoice cron log (Sam Loom #14).
--
-- Per-run audit of the weekly auto-invoice job that bills clients for the
-- previous week's LeadByte deliveries. Replaces Sam's external Make.com
-- automation.
--
-- One row per cron tick (or manual run). Per-client outcomes are stored on
-- `details` as a jsonb array so a failed client invoice doesn't lose its
-- context — the cron logs every client and continues, rather than aborting
-- on the first error.
--
-- Idempotent: safe to re-run on every deploy.

CREATE TABLE IF NOT EXISTS auto_invoice_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id),
  -- Week being billed (Monday → Sunday inclusive). The cron typically fires
  -- on Monday morning for the previous Mon-Sun week.
  period_from date NOT NULL,
  period_to date NOT NULL,
  -- 'scheduled' (cron) or 'manual' (admin-triggered via UI)
  triggered_by varchar(20) NOT NULL DEFAULT 'scheduled',
  triggered_by_user_id uuid REFERENCES users(id),
  -- 'running' | 'completed' | 'failed' | 'skipped'
  status varchar(20) NOT NULL DEFAULT 'running',
  -- Roll-up counters for the index view; full per-client breakdown lives in `details`.
  clients_billed integer NOT NULL DEFAULT 0,
  clients_skipped integer NOT NULL DEFAULT 0,
  clients_failed integer NOT NULL DEFAULT 0,
  invoices_created integer NOT NULL DEFAULT 0,
  total_amount decimal(14, 2) NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL DEFAULT 'GBP',
  -- Array of { clientId, clientName, leads, amount, invoiceId?, status, reason? }.
  -- Status: 'invoiced' | 'no_deliveries' | 'no_lead_price' | 'failed'.
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_invoice_runs_business_idx ON auto_invoice_runs(business_id);
CREATE INDEX IF NOT EXISTS auto_invoice_runs_started_idx ON auto_invoice_runs(started_at DESC);
