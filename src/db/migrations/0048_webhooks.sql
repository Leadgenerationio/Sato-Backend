-- Plan phase 4 (docs/creative-library-and-api-plan.md): outbound webhooks.
-- Sam's feedback round 1, section 5 part 7: "creative added", "creative
-- changed", "client added", signed with a secret.
--
-- secret_sealed holds the signing secret AES-256-GCM encrypted with
-- WEBHOOK_SECRET_KEY (src/utils/secret-box.ts). A hash can't be used: each
-- delivery is signed with HMAC-SHA256, which needs the raw secret.
--
-- Schema only, no data statements: scripts/auto-migrate.ts re-applies every
-- migration file on every boot, so everything here must be a no-op on re-run.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  url varchar(2048) NOT NULL,
  description varchar(255),
  secret_sealed text NOT NULL,
  -- First characters of the secret, so the Owner can tell keys apart.
  secret_hint varchar(16) NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamp,
  disabled_reason varchar(255),
  last_success_at timestamp,
  last_failure_at timestamp,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_endpoints_business_idx ON webhook_endpoints (business_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  -- pending → (retrying →)* succeeded | failed | cancelled
  status varchar(20) NOT NULL DEFAULT 'pending',
  response_code integer,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp,
  last_error text,
  delivered_at timestamp,
  created_at timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx ON webhook_deliveries (status);
