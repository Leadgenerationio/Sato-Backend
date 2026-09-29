-- Public API keys, usage log and Idempotency-Key replay store (plan phase 2;
-- docs/creative-library-and-api-plan.md). DDL only — idempotent on every boot.
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name varchar(100) NOT NULL,
  prefix varchar(16) NOT NULL,
  hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_keys_business_idx ON api_keys (business_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_key_usage (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  method varchar(8) NOT NULL,
  path varchar(300) NOT NULL,
  status integer NOT NULL,
  at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_key_usage_key_at_idx ON api_key_usage (api_key_id, at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner varchar(60) NOT NULL,
  key varchar(100) NOT NULL,
  request_hash char(64) NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, key)
);
